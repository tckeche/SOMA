/**
 * Shared PGlite harness for examiner-insights review-queue integration
 * tests.
 *
 * Both `examinerInsightsReviewQueue.pg.test.ts` (read path) and
 * `examinerInsightsReviewMutations.pg.test.ts` (write path) need the
 * same world: the catalogue chain (body → … → subtopic), three users
 * (one tutor, one reviewer, one out-of-scope tutor), a tutor-owned
 * quiz on syllabus 0580, and two source documents (one in-scope on
 * 0580, one out-of-scope on 0625).
 *
 * The generic in-process-Postgres bits (migrations, db creation, the
 * server/db mock, and the catalogue chain itself) live in
 * `./pglite.ts`. This file is just the review-queue-specific seeding
 * on top.
 */
import { type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@shared/schema";
import {
  somaUsers,
  somaQuizzes,
  syllabusDocuments,
} from "@shared/schema";
import { seedCatalogue } from "./pglite";

// Re-exported so existing call sites (and any new ones) can keep
// importing migrations and db creation from this file. New tests
// should prefer importing directly from `./pglite`.
export {
  applyMigrations,
  createTestDb,
  mockServerDb,
  seedCatalogue,
  MIGRATIONS,
  type TestDbHarness,
  type TestDrizzleDb,
} from "./pglite";

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
  const { subtopicId } = await seedCatalogue(testDb);

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
    subtopicId,
    documentId: doc.id,
    otherDocumentId: otherDoc.id,
  };
}
