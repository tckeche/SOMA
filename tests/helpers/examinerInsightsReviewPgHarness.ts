/**
 * Shared PGlite harness for examiner-insights review-queue integration tests.
 *
 * Both `examinerInsightsReviewQueue.pg.test.ts` (read path) and
 * `examinerInsightsReviewMutations.pg.test.ts` (write path) use the same
 * in-process Postgres setup: apply the project drizzle migrations, then
 * seed the catalogue chain (body → level → subject → syllabus →
 * strand → topic → subtopic), the user accounts, a tutor-owned quiz,
 * and the source documents the queue rows reference.
 *
 * Test files insert their own `examiner_misconceptions` rows on top of
 * this base — the read tests use a fixed seed so ordering can be
 * asserted, the write tests insert per-test rows and mutate them.
 *
 * A future task (see `Make the in-process Postgres test setup reusable
 * across other services`) will generalise this further; for now the
 * scope is just the review-queue tests.
 */
import { PGlite } from "@electric-sql/pglite";
import { type PgliteDatabase } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@shared/schema";
import {
  examiningBodies,
  levels,
  subjects,
  syllabi,
  syllabusStrands,
  topics,
  subtopics,
  somaUsers,
  somaQuizzes,
  syllabusDocuments,
} from "@shared/schema";

/**
 * Migration files applied in order. Mirrors what `drizzle-kit push`
 * would run against a fresh database.
 */
export const MIGRATIONS = [
  "0000_catalogue.sql",
  "0001_phase1_fk_and_ai_usage.sql",
  "0002_phase2_examiner_loop.sql",
  "0003_phase2_misconception_year.sql",
  "0004_phase3_revision_plans.sql",
  "0005_phase4_command_word_performance.sql",
];

export async function applyMigrations(client: PGlite): Promise<void> {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(
      path.join(import.meta.dirname, "..", "..", "migrations", file),
      "utf8",
    );
    if (!sql.trim()) continue;
    // PGlite accepts the whole file at once; drizzle's
    // `--> statement-breakpoint` markers are SQL line comments and are
    // simply ignored by Postgres.
    await client.exec(sql);
  }
}

export interface BaseFixtureOptions {
  tutorId?: string;
  reviewerId?: string;
  otherTutorId?: string;
}

export interface BaseFixtureIds {
  tutorId: string;
  reviewerId: string;
  otherTutorId: string;
  /** A real subtopic on syllabus 0580 so write tests can link/unlink. */
  subtopicId: number;
  /** Source document on the in-scope syllabus 0580. */
  documentId: number;
  /** Source document on the out-of-scope syllabus 0625. */
  otherDocumentId: number;
}

/**
 * Seed the "world" every review-queue test needs: catalogue chain,
 * users, one tutor-authored quiz on syllabus 0580, and two source
 * documents (one in-scope on 0580, one out-of-scope on 0625).
 *
 * Caller is responsible for inserting `examiner_misconceptions` rows
 * on top — the seed shape varies per test.
 */
export async function setupBaseFixtures(
  testDb: PgliteDatabase<typeof schema>,
  opts: BaseFixtureOptions = {},
): Promise<BaseFixtureIds> {
  const tutorId = opts.tutorId ?? "00000000-0000-0000-0000-000000000010";
  const reviewerId = opts.reviewerId ?? "00000000-0000-0000-0000-000000000020";
  const otherTutorId = opts.otherTutorId ?? "00000000-0000-0000-0000-000000000030";

  // ---- Catalogue chain so a real subtopic row can exist ----
  const [body] = await testDb
    .insert(examiningBodies)
    .values({ slug: "cambridge", displayName: "Cambridge" })
    .returning();
  await testDb
    .insert(levels)
    .values({ code: "IGCSE", displayName: "IGCSE", topBand: "IGCSE" });
  const [subj] = await testDb
    .insert(subjects)
    .values({
      examiningBodyId: body.id,
      name: "Mathematics",
      slug: "mathematics",
    })
    .returning();
  const [syl] = await testDb
    .insert(syllabi)
    .values({
      examiningBodyId: body.id,
      subjectId: subj.id,
      topBand: "IGCSE",
      syllabusCode: "0580",
      title: "Cambridge IGCSE Mathematics",
    })
    .returning();
  const [strand] = await testDb
    .insert(syllabusStrands)
    .values({ syllabusId: syl.id, name: "Number" })
    .returning();
  const [topic] = await testDb
    .insert(topics)
    .values({
      syllabusId: syl.id,
      strandId: strand.id,
      topicNumber: "1",
      title: "Number basics",
    })
    .returning();
  const [sub] = await testDb
    .insert(subtopics)
    .values({
      topicId: topic.id,
      subtopicNumber: "1.1",
      title: "Place value",
      levelTier: "IGCSE",
    })
    .returning();

  // ---- Users (reviewer + two tutors) ----
  await testDb.insert(somaUsers).values([
    {
      id: tutorId,
      email: "tutor@example.com",
      displayName: "Test Tutor",
      role: "tutor",
    },
    {
      id: reviewerId,
      email: "reviewer@example.com",
      displayName: "Review Admin",
      role: "admin",
    },
    {
      id: otherTutorId,
      email: "other@example.com",
      displayName: "Other Tutor",
      role: "tutor",
    },
  ]);

  // ---- Tutor scope: one quiz on the in-scope syllabus ----
  // parseBoardAndCode("Cambridge IGCSE 0580") → board="Cambridge IGCSE",
  // syllabusCode="0580", which matches the misconceptions inserted by
  // callers below.
  await testDb.insert(somaQuizzes).values({
    title: "Algebra basics",
    topic: "Algebra",
    syllabus: "Cambridge IGCSE 0580",
    authorId: tutorId,
  });

  // ---- Source documents: one in-scope, one out-of-scope ----
  const [doc] = await testDb
    .insert(syllabusDocuments)
    .values({
      board: "Cambridge IGCSE",
      level: "IGCSE",
      syllabusCode: "0580",
      filename: "cambridge-2024-er.pdf",
      extractedText: "...",
      documentType: "examiner_report",
    })
    .returning();

  const [otherDoc] = await testDb
    .insert(syllabusDocuments)
    .values({
      board: "Cambridge IGCSE",
      level: "IGCSE",
      syllabusCode: "0625",
      filename: "physics-2024-er.pdf",
      extractedText: "...",
      documentType: "examiner_report",
    })
    .returning();

  return {
    tutorId,
    reviewerId,
    otherTutorId,
    subtopicId: sub.id,
    documentId: doc.id,
    otherDocumentId: otherDoc.id,
  };
}
