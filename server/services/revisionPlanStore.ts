/**
 * Phase 3.3 — persistence for revision plans.
 *
 * Read / write helpers around the `revision_plans` table. Lives outside
 * storage.ts per server/storage-pattern.md.
 */
import { db } from "../db";
import { revisionPlans, type RevisionPlan, type RevisionPlanBody } from "@shared/schema";
import { and, eq } from "drizzle-orm";

export interface UpsertPlanInput {
  studentId: string;
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  examDate: Date | null;
  weekHours: number;
  body: RevisionPlanBody;
}

export async function getPlan(args: {
  studentId: string;
  subject: string;
  syllabusCode: string;
  level: string;
}): Promise<RevisionPlan | null> {
  if (!db) return null;
  const [row] = await db
    .select()
    .from(revisionPlans)
    .where(
      and(
        eq(revisionPlans.studentId, args.studentId),
        eq(revisionPlans.subject, args.subject),
        eq(revisionPlans.syllabusCode, args.syllabusCode),
        eq(revisionPlans.level, args.level),
      ),
    );
  return row ?? null;
}

export async function listPlansForStudent(studentId: string): Promise<RevisionPlan[]> {
  if (!db) return [];
  return db
    .select()
    .from(revisionPlans)
    .where(eq(revisionPlans.studentId, studentId));
}

export async function upsertPlan(input: UpsertPlanInput): Promise<RevisionPlan> {
  if (!db) {
    throw new Error("revisionPlanStore.upsertPlan requires a configured database.");
  }
  const values = {
    studentId: input.studentId,
    subject: input.subject,
    examBody: input.examBody,
    syllabusCode: input.syllabusCode,
    level: input.level,
    examDate: input.examDate,
    weekHours: input.weekHours,
    weeks: input.body.weeks,
    summary: input.body.summary,
    weakAreas: input.body.weakAreas,
    stale: false,
    generatedAt: new Date(),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(revisionPlans)
    .values(values)
    .onConflictDoUpdate({
      target: [revisionPlans.studentId, revisionPlans.subject, revisionPlans.syllabusCode, revisionPlans.level],
      set: {
        examBody: values.examBody,
        examDate: values.examDate,
        weekHours: values.weekHours,
        weeks: values.weeks,
        summary: values.summary,
        weakAreas: values.weakAreas,
        stale: false,
        generatedAt: values.generatedAt,
        updatedAt: values.updatedAt,
      },
    })
    .returning();
  return row;
}

/**
 * Mark all of a student's plans stale. Called after each submission so
 * the UI can show a "Refresh plan" prompt.
 */
export async function markPlansStale(studentId: string, lastReportId: number | null = null): Promise<void> {
  if (!db) return;
  await db
    .update(revisionPlans)
    .set({ stale: true, lastReportId, updatedAt: new Date() })
    .where(eq(revisionPlans.studentId, studentId));
}
