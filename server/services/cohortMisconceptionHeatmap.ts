/**
 * Phase 3.4 — Cohort Misconception Heatmap.
 *
 * For a given tutor, aggregates `student_misconceptions` across every
 * student the tutor has adopted (via tutor_students). Groups by
 * misconception so the tutor can see "12 of my 18 students hold this
 * misconception" at a glance.
 *
 * Privacy floor: only misconceptions held by at least
 * MIN_STUDENT_COUNT (currently 1) students are returned. Bump this to
 * 3-5 when cohorts are larger to avoid de-anonymising small classes.
 * One-student rows are still useful for the tutor's individual view —
 * they are exposed via per-student endpoints, not this aggregate.
 */
import { db } from "../db";
import {
  examinerMisconceptions,
  somaUsers,
  studentMisconceptions,
  subtopics,
  topics,
  tutorStudents,
} from "@shared/schema";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

const MIN_STUDENT_COUNT = 1;

export interface HeatmapStudent {
  id: string;
  displayName: string | null;
  evidenceCount: number;
  lastSeenAt: string;
}

export interface HeatmapRow {
  misconceptionId: number;
  misconception: string;
  studentError: string;
  correctApproach: string;
  topic: string;
  subtopicTitle: string | null;
  examYear: number | null;
  frequency: string;
  syllabusCode: string;
  examBody: string;
  affectedStudents: HeatmapStudent[];
  totalEvidence: number;
}

export interface HeatmapPayload {
  rows: HeatmapRow[];
  cohortSize: number;
}

export async function buildCohortMisconceptionHeatmap(tutorId: string): Promise<HeatmapPayload> {
  const empty: HeatmapPayload = { rows: [], cohortSize: 0 };
  if (!db) return empty;

  // 1. Adopted students.
  const cohort = await db
    .select({ id: tutorStudents.studentId })
    .from(tutorStudents)
    .where(eq(tutorStudents.tutorId, tutorId));
  const studentIds = cohort.map((r) => r.id);
  if (studentIds.length === 0) return empty;

  // 2. All ACTIVE student_misconceptions for these students.
  const rows = await db
    .select({
      studentId: studentMisconceptions.studentId,
      studentDisplayName: somaUsers.displayName,
      misconceptionId: studentMisconceptions.misconceptionId,
      evidenceCount: studentMisconceptions.evidenceCount,
      lastSeenAt: studentMisconceptions.lastSeenAt,
      resolvedAt: studentMisconceptions.resolvedAt,
      misconception: examinerMisconceptions.misconception,
      studentError: examinerMisconceptions.studentError,
      correctApproach: examinerMisconceptions.correctApproach,
      examinerTopic: examinerMisconceptions.topic,
      subtopicTitle: subtopics.title,
      topicTitle: topics.title,
      examYear: examinerMisconceptions.examYear,
      frequency: examinerMisconceptions.frequency,
      syllabusCode: examinerMisconceptions.syllabusCode,
      examBody: examinerMisconceptions.board,
    })
    .from(studentMisconceptions)
    .innerJoin(examinerMisconceptions, eq(examinerMisconceptions.id, studentMisconceptions.misconceptionId))
    .leftJoin(somaUsers, eq(somaUsers.id, studentMisconceptions.studentId))
    .leftJoin(subtopics, eq(subtopics.id, examinerMisconceptions.subtopicId))
    .leftJoin(topics, eq(topics.id, subtopics.topicId))
    .where(
      and(
        inArray(studentMisconceptions.studentId, studentIds),
        isNull(studentMisconceptions.resolvedAt),
        gt(studentMisconceptions.evidenceCount, 0),
      ),
    );

  // 3. Group by misconception.
  const grouped = new Map<number, HeatmapRow>();
  for (const r of rows) {
    let row = grouped.get(r.misconceptionId);
    if (!row) {
      row = {
        misconceptionId: r.misconceptionId,
        misconception: r.misconception,
        studentError: r.studentError,
        correctApproach: r.correctApproach,
        topic: r.topicTitle ?? r.examinerTopic,
        subtopicTitle: r.subtopicTitle ?? null,
        examYear: r.examYear,
        frequency: r.frequency,
        syllabusCode: r.syllabusCode,
        examBody: r.examBody,
        affectedStudents: [],
        totalEvidence: 0,
      };
      grouped.set(r.misconceptionId, row);
    }
    row.affectedStudents.push({
      id: r.studentId,
      displayName: r.studentDisplayName ?? null,
      evidenceCount: r.evidenceCount,
      lastSeenAt: r.lastSeenAt.toISOString(),
    });
    row.totalEvidence += r.evidenceCount;
  }

  // 4. Apply privacy floor + sort by impact (number of students × avg evidence).
  const filtered = Array.from(grouped.values())
    .filter((r) => r.affectedStudents.length >= MIN_STUDENT_COUNT)
    .sort((a, b) => {
      // Sort by # affected students first, then total evidence as tie-breaker.
      if (b.affectedStudents.length !== a.affectedStudents.length) {
        return b.affectedStudents.length - a.affectedStudents.length;
      }
      return b.totalEvidence - a.totalEvidence;
    });

  return { rows: filtered, cohortSize: studentIds.length };
}
