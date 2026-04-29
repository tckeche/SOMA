/**
 * Phase 3.1 — Syllabus Mastery Map.
 *
 * Returns a Cambridge-tree view (subject → topic → subtopic) for a
 * student, with mastery %, attempt counts, and per-leaf badges
 * (covered / tested / mastered).
 *
 * Replaces the fuzzy free-text radar in `syllabusInsights.ts` for the
 * mastery-map surface specifically. Keys roll up against catalogue
 * subtopic ids when available, and fall back to case-insensitive
 * topic-name matching for legacy mastery rows that the FK backfill
 * hasn't reached yet.
 *
 * Data sources
 *   - student_subjects                — subjects the student is in
 *   - syllabi / topics / subtopics    — catalogue tree
 *   - student_topic_mastery           — per-row mastery (FK or text)
 *   - examiner_misconceptions         — count of approved insights per
 *                                       subtopic (so the UI can flag
 *                                       "high-error" leaves)
 */
import { db } from "../db";
import {
  examinerMisconceptions,
  studentSubjects,
  studentTopicMastery,
  subjects,
  subtopics,
  syllabi,
  topics,
} from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export interface SubtopicLeaf {
  id: number | null;
  number: string | null;
  title: string;
  understandingPercent: number;
  attempts: number;
  totalQuestions: number;
  correctQuestions: number;
  covered: boolean;
  tested: boolean;
  masteryAchieved: boolean;
  lastTestedAt: string | null;
  /** Number of approved examiner misconceptions tagged to this subtopic. */
  examinerInsightCount: number;
  /** True when the leaf is keyed by FK; false when matched only by
   *  free-text title (caller can use this to badge "needs backfill"). */
  fkLinked: boolean;
}

export interface TopicNode {
  id: number;
  title: string;
  topicNumber: string | null;
  subtopics: SubtopicLeaf[];
  // Aggregated rollups across the topic's subtopics (weighted by
  // totalQuestions; falls back to a flat avg when no testing data
  // exists yet).
  understandingPercent: number;
  attempts: number;
  totalQuestions: number;
  attemptedSubtopics: number;
  totalSubtopics: number;
  examinerInsightCount: number;
}

export interface SubjectNode {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  topics: TopicNode[];
  understandingPercent: number;
  totalSubtopics: number;
  attemptedSubtopics: number;
  masteredSubtopics: number;
  examinerInsightCount: number;
}

export interface MasteryMap {
  subjects: SubjectNode[];
}

interface MasteryRow {
  subtopicId: number | null;
  subject: string;
  topic: string;
  subtopic: string | null;
  understandingPercent: number;
  attempts: number;
  totalQuestions: number;
  correctQuestions: number;
  covered: boolean;
  tested: boolean;
  masteryAchieved: boolean;
  lastTestedAt: Date | null;
}

/**
 * Build a key for case-insensitive title-based fallback matching when
 * the student_topic_mastery row predates the FK backfill.
 */
function fallbackKey(subject: string, topicTitle: string, subtopicTitle: string | null): string {
  const t = (subtopicTitle ?? topicTitle).toLowerCase().trim();
  return `${subject.toLowerCase().trim()}|${t}`;
}

function aggregateUnderstanding(rows: { understandingPercent: number; totalQuestions: number }[]): number {
  if (rows.length === 0) return 0;
  let weight = 0;
  let weighted = 0;
  let flat = 0;
  for (const r of rows) {
    if (r.totalQuestions > 0) {
      weight += r.totalQuestions;
      weighted += r.understandingPercent * r.totalQuestions;
    }
    flat += r.understandingPercent;
  }
  if (weight > 0) return Math.round(weighted / weight);
  return Math.round(flat / rows.length);
}

export async function buildMasteryMap(studentId: string): Promise<MasteryMap> {
  const empty: MasteryMap = { subjects: [] };
  if (!db) return empty;

  // 1. What's the student enrolled in?
  const enrolments = await db
    .select({
      subject: studentSubjects.subject,
      examBody: studentSubjects.examBody,
      syllabusCode: studentSubjects.syllabusCode,
      level: studentSubjects.level,
    })
    .from(studentSubjects)
    .where(eq(studentSubjects.studentId, studentId));
  if (enrolments.length === 0) return empty;

  // 2. Pull the student's mastery rows once.
  const masteryRowsRaw = await db
    .select({
      subtopicId: studentTopicMastery.subtopicId,
      subject: studentTopicMastery.subject,
      topic: studentTopicMastery.topic,
      subtopic: studentTopicMastery.subtopic,
      understandingPercent: studentTopicMastery.understandingPercent,
      attempts: studentTopicMastery.attempts,
      totalQuestions: studentTopicMastery.totalQuestions,
      correctQuestions: studentTopicMastery.correctQuestions,
      covered: studentTopicMastery.covered,
      tested: studentTopicMastery.tested,
      masteryAchieved: studentTopicMastery.masteryAchieved,
      lastTestedAt: studentTopicMastery.lastTestedAt,
    })
    .from(studentTopicMastery)
    .where(eq(studentTopicMastery.studentId, studentId));

  const masteryById = new Map<number, MasteryRow>();
  const masteryByKey = new Map<string, MasteryRow>();
  for (const m of masteryRowsRaw) {
    if (m.subtopicId) masteryById.set(m.subtopicId, m as MasteryRow);
    masteryByKey.set(fallbackKey(m.subject, m.topic, m.subtopic), m as MasteryRow);
  }

  // 3. For each enrolment, fetch the catalogue tree.
  const subjectNodes: SubjectNode[] = [];
  for (const enrol of enrolments) {
    const [syllabusRow] = await db
      .select({ id: syllabi.id })
      .from(syllabi)
      .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
      .where(and(eq(syllabi.syllabusCode, enrol.syllabusCode), sql`lower(${subjects.name}) = lower(${enrol.subject})`));

    if (!syllabusRow) {
      // Catalogue not yet ingested for this syllabus — emit an empty
      // subject node so the UI can gracefully show "no data yet"
      // instead of a 404.
      subjectNodes.push({
        subject: enrol.subject,
        examBody: enrol.examBody,
        syllabusCode: enrol.syllabusCode,
        level: enrol.level,
        topics: [],
        understandingPercent: 0,
        totalSubtopics: 0,
        attemptedSubtopics: 0,
        masteredSubtopics: 0,
        examinerInsightCount: 0,
      });
      continue;
    }

    const topicRows = await db
      .select({
        id: topics.id,
        title: topics.title,
        topicNumber: topics.topicNumber,
      })
      .from(topics)
      .where(eq(topics.syllabusId, syllabusRow.id))
      .orderBy(topics.sortOrder);

    if (topicRows.length === 0) {
      subjectNodes.push({
        subject: enrol.subject,
        examBody: enrol.examBody,
        syllabusCode: enrol.syllabusCode,
        level: enrol.level,
        topics: [],
        understandingPercent: 0,
        totalSubtopics: 0,
        attemptedSubtopics: 0,
        masteredSubtopics: 0,
        examinerInsightCount: 0,
      });
      continue;
    }

    const topicIds = topicRows.map((t) => t.id);
    const subtopicRows = await db
      .select({
        id: subtopics.id,
        topicId: subtopics.topicId,
        number: subtopics.subtopicNumber,
        title: subtopics.title,
        levelTier: subtopics.levelTier,
      })
      .from(subtopics)
      .where(and(inArray(subtopics.topicId, topicIds), eq(subtopics.levelTier, enrol.level)))
      .orderBy(subtopics.sortOrder);

    // Filter to the level the student is actually doing (IGCSE / AS / A2).
    // Some syllabi don't tier subtopics — fall back to all rows when the
    // tiered query returns empty.
    let scopedSubtopics = subtopicRows;
    if (scopedSubtopics.length === 0) {
      scopedSubtopics = await db
        .select({
          id: subtopics.id,
          topicId: subtopics.topicId,
          number: subtopics.subtopicNumber,
          title: subtopics.title,
          levelTier: subtopics.levelTier,
        })
        .from(subtopics)
        .where(inArray(subtopics.topicId, topicIds))
        .orderBy(subtopics.sortOrder);
    }

    // 4. Insight counts per subtopic for this syllabus.
    const insightRows = scopedSubtopics.length === 0
      ? []
      : await db
          .select({ subtopicId: examinerMisconceptions.subtopicId, count: sql<number>`count(*)::int` })
          .from(examinerMisconceptions)
          .where(
            and(
              eq(examinerMisconceptions.status, "approved"),
              inArray(
                examinerMisconceptions.subtopicId,
                scopedSubtopics.map((s) => s.id),
              ),
            ),
          )
          .groupBy(examinerMisconceptions.subtopicId);
    const insightCountById = new Map<number, number>();
    for (const r of insightRows) {
      if (r.subtopicId !== null) insightCountById.set(r.subtopicId, Number(r.count) || 0);
    }

    // 5. Compose topic nodes.
    const topicNodes: TopicNode[] = [];
    let subjectInsightTotal = 0;
    let subjectMastered = 0;
    let subjectAttempted = 0;
    let subjectTotalSubtopics = 0;

    for (const t of topicRows) {
      const myLeaves: SubtopicLeaf[] = scopedSubtopics
        .filter((s) => s.topicId === t.id)
        .map((s) => {
          const m = masteryById.get(s.id) ?? masteryByKey.get(fallbackKey(enrol.subject, t.title, s.title));
          const insightCount = insightCountById.get(s.id) ?? 0;
          subjectInsightTotal += insightCount;
          subjectTotalSubtopics += 1;
          if (m && m.totalQuestions > 0) subjectAttempted += 1;
          if (m && m.masteryAchieved) subjectMastered += 1;
          return {
            id: s.id,
            number: s.number,
            title: s.title,
            understandingPercent: m?.understandingPercent ?? 0,
            attempts: m?.attempts ?? 0,
            totalQuestions: m?.totalQuestions ?? 0,
            correctQuestions: m?.correctQuestions ?? 0,
            covered: m?.covered ?? false,
            tested: m?.tested ?? false,
            masteryAchieved: m?.masteryAchieved ?? false,
            lastTestedAt: m?.lastTestedAt ? m.lastTestedAt.toISOString() : null,
            examinerInsightCount: insightCount,
            fkLinked: !!(m && m.subtopicId === s.id),
          };
        });
      const understandingPercent = aggregateUnderstanding(myLeaves);
      const attempts = myLeaves.reduce((acc, l) => acc + l.attempts, 0);
      const totalQuestions = myLeaves.reduce((acc, l) => acc + l.totalQuestions, 0);
      const attemptedSubtopics = myLeaves.filter((l) => l.totalQuestions > 0).length;
      const examinerInsightCount = myLeaves.reduce((acc, l) => acc + l.examinerInsightCount, 0);
      topicNodes.push({
        id: t.id,
        title: t.title,
        topicNumber: t.topicNumber,
        subtopics: myLeaves,
        understandingPercent,
        attempts,
        totalQuestions,
        attemptedSubtopics,
        totalSubtopics: myLeaves.length,
        examinerInsightCount,
      });
    }

    // 6. Subject-level rollup (weighted by totalQuestions across the
    // whole tree).
    const allLeaves = topicNodes.flatMap((tn) => tn.subtopics);
    const subjectUnderstanding = aggregateUnderstanding(allLeaves);

    subjectNodes.push({
      subject: enrol.subject,
      examBody: enrol.examBody,
      syllabusCode: enrol.syllabusCode,
      level: enrol.level,
      topics: topicNodes,
      understandingPercent: subjectUnderstanding,
      totalSubtopics: subjectTotalSubtopics,
      attemptedSubtopics: subjectAttempted,
      masteredSubtopics: subjectMastered,
      examinerInsightCount: subjectInsightTotal,
    });
  }

  return { subjects: subjectNodes };
}
