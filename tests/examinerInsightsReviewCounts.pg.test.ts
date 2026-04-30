/**
 * INTEGRATION TESTS — examiner-insights review counts against a real Postgres.
 *
 * The `byConfidence` breakdown returned by `countsByStatus()` /
 * `countsByStatusForTutor()` powers the breakdown bar inside the
 * Pending pill in the queue UI. If the bucket thresholds, the status
 * filter, or the source `confidence` column ever drift, that bar will
 * silently render wrong shares with no surface symptom — every total
 * still adds up to the same number of rows; only the per-bucket split
 * goes wrong.
 *
 * This file boots an in-process Postgres via PGlite, applies the
 * project migrations, seeds rows that span pending/approved/rejected at
 * each confidence bucket *and* at each bucket boundary (>=80 high,
 * 50–79 medium, <50 low, null=unknown), and then asserts:
 *
 *   1. The per-status totals match the seeded counts.
 *   2. For each status, `byConfidence` sums exactly to the status total.
 *      This is the invariant the breakdown bar relies on.
 *   3. The boundary values land in the bucket the threshold spec says
 *      they should (80 → high, 79 → medium, 50 → medium, 49 → low).
 *
 * Both the unscoped admin view (`countsByStatus`) and the tutor-scoped
 * view (`countsByStatusForTutor`) are exercised the same way so a
 * threshold or status-filter drift in either function is caught.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@shared/schema";

let pglite: PGlite | null = null;
let testDb: PgliteDatabase<typeof schema> | null = null;

vi.mock("../server/db", () => ({
  get db() {
    return testDb;
  },
  pool: null,
  connectDb: async () => {},
}));

import {
  examinerMisconceptions,
  syllabusDocuments,
  somaUsers,
  somaQuizzes,
} from "@shared/schema";

import {
  countsByStatus,
  countsByStatusForTutor,
} from "../server/services/examinerInsightsReview";

const TUTOR_ID = "00000000-0000-0000-0000-000000000110";
const OTHER_TUTOR_ID = "00000000-0000-0000-0000-000000000111";

const MIGRATIONS = [
  "0000_catalogue.sql",
  "0001_phase1_fk_and_ai_usage.sql",
  "0002_phase2_examiner_loop.sql",
  "0003_phase2_misconception_year.sql",
  "0004_phase3_revision_plans.sql",
  "0005_phase4_command_word_performance.sql",
];

async function applyMigrations(client: PGlite): Promise<void> {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(
      path.join(import.meta.dirname, "..", "migrations", file),
      "utf8",
    );
    if (!sql.trim()) continue;
    await client.exec(sql);
  }
}

/**
 * Seed plan, designed so each status has a different total *and* each
 * status exercises every bucket including the boundary values:
 *
 *   pending  (5 rows): high=2 (80, 100), medium=1 (79), low=1 (49),  unknown=1 (null)
 *   approved (4 rows): high=1 (90),      medium=2 (50, 65), low=0,   unknown=1 (null)
 *   rejected (3 rows): high=0,           medium=0,          low=2 (0, 30), unknown=1 (null)
 *
 * Boundary coverage:
 *   80  → high   (>=80 lower bound)
 *   79  → medium (just below high)
 *   50  → medium (>=50 lower bound)
 *   49  → low    (just below medium)
 *   0   → low    (lowest non-null value)
 *   null→ unknown
 */
const SEED: Array<{ status: "pending" | "approved" | "rejected"; confidence: number | null }> = [
  // pending — 5 rows, totals: high 2, medium 1, low 1, unknown 1
  { status: "pending", confidence: 100 },
  { status: "pending", confidence: 80 },
  { status: "pending", confidence: 79 },
  { status: "pending", confidence: 49 },
  { status: "pending", confidence: null },
  // approved — 4 rows, totals: high 1, medium 2, low 0, unknown 1
  { status: "approved", confidence: 90 },
  { status: "approved", confidence: 65 },
  { status: "approved", confidence: 50 },
  { status: "approved", confidence: null },
  // rejected — 3 rows, totals: high 0, medium 0, low 2, unknown 1
  { status: "rejected", confidence: 30 },
  { status: "rejected", confidence: 0 },
  { status: "rejected", confidence: null },
];

const EXPECTED = {
  pending: { total: 5, high: 2, medium: 1, low: 1, unknown: 1 },
  approved: { total: 4, high: 1, medium: 2, low: 0, unknown: 1 },
  rejected: { total: 3, high: 0, medium: 0, low: 2, unknown: 1 },
} as const;

beforeAll(async () => {
  pglite = new PGlite();
  await applyMigrations(pglite);
  testDb = drizzlePglite(pglite, { schema });

  await testDb.insert(somaUsers).values([
    {
      id: TUTOR_ID,
      email: "counts-tutor@example.com",
      displayName: "Counts Tutor",
      role: "tutor",
    },
    {
      id: OTHER_TUTOR_ID,
      email: "counts-other@example.com",
      displayName: "Other Tutor",
      role: "tutor",
    },
  ]);

  // Tutor scope must include the seeded board+code so
  // countsByStatusForTutor sees every seeded row.
  await testDb.insert(somaQuizzes).values({
    title: "Counts scope quiz",
    topic: "Algebra",
    syllabus: "Cambridge IGCSE 0580",
    authorId: TUTOR_ID,
  });

  const [doc] = await testDb
    .insert(syllabusDocuments)
    .values({
      board: "Cambridge IGCSE",
      level: "IGCSE",
      syllabusCode: "0580",
      filename: "counts-2026.pdf",
      extractedText: "...",
      documentType: "examiner_report",
    })
    .returning();

  await testDb.insert(examinerMisconceptions).values(
    SEED.map((row, idx) => ({
      documentId: doc.id,
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      topic: "Algebra",
      misconception: `seed-${idx}`,
      studentError: `error-${idx}`,
      correctApproach: `approach-${idx}`,
      frequency: "common",
      status: row.status,
      confidence: row.confidence,
      extractedAt: new Date(2026, 0, idx + 1),
    })),
  );

  // One out-of-scope row that the tutor-scoped query must ignore but
  // the unscoped admin query must count. It's a confidence-bucket
  // value that, if leaked, would shift the medium count for pending.
  await testDb.insert(examinerMisconceptions).values({
    documentId: doc.id,
    board: "Cambridge IGCSE",
    syllabusCode: "0625",
    topic: "Forces",
    misconception: "out-of-scope",
    studentError: "noise",
    correctApproach: "n/a",
    frequency: "rare",
    status: "pending",
    confidence: 70, // medium bucket
    extractedAt: new Date(2026, 5, 1),
  });
}, 60_000);

afterAll(async () => {
  if (pglite) await pglite.close();
  pglite = null;
  testDb = null;
});

function sumBuckets(b: { high: number; medium: number; low: number; unknown: number }): number {
  return b.high + b.medium + b.low + b.unknown;
}

describe("countsByStatus — bucket totals match status totals", () => {
  it("per-status totals match the seeded counts (including the out-of-scope row)", async () => {
    const c = await countsByStatus();
    // pending = 5 in-scope + 1 out-of-scope (admin sees both).
    expect(c.pending).toBe(EXPECTED.pending.total + 1);
    expect(c.approved).toBe(EXPECTED.approved.total);
    expect(c.rejected).toBe(EXPECTED.rejected.total);
  });

  it("byConfidence sums exactly to the status total for every status", async () => {
    const c = await countsByStatus();
    expect(sumBuckets(c.byConfidence.pending)).toBe(c.pending);
    expect(sumBuckets(c.byConfidence.approved)).toBe(c.approved);
    expect(sumBuckets(c.byConfidence.rejected)).toBe(c.rejected);
  });

  it("places boundary confidence values into the documented buckets", async () => {
    const c = await countsByStatus();
    // pending: high=2 (80, 100) plus the seed-only counts; out-of-scope
    // 70 lands in medium so medium becomes 1+1=2.
    expect(c.byConfidence.pending.high).toBe(EXPECTED.pending.high); // 80 + 100
    expect(c.byConfidence.pending.medium).toBe(EXPECTED.pending.medium + 1); // 79 + 70
    expect(c.byConfidence.pending.low).toBe(EXPECTED.pending.low); // 49
    expect(c.byConfidence.pending.unknown).toBe(EXPECTED.pending.unknown);

    // approved: 50 must land in medium (>=50 lower boundary), 90 in high.
    expect(c.byConfidence.approved.high).toBe(EXPECTED.approved.high);
    expect(c.byConfidence.approved.medium).toBe(EXPECTED.approved.medium); // 50 + 65
    expect(c.byConfidence.approved.low).toBe(EXPECTED.approved.low);
    expect(c.byConfidence.approved.unknown).toBe(EXPECTED.approved.unknown);

    // rejected: 0 and 30 are both in low; null is unknown.
    expect(c.byConfidence.rejected.high).toBe(EXPECTED.rejected.high);
    expect(c.byConfidence.rejected.medium).toBe(EXPECTED.rejected.medium);
    expect(c.byConfidence.rejected.low).toBe(EXPECTED.rejected.low); // 0 + 30
    expect(c.byConfidence.rejected.unknown).toBe(EXPECTED.rejected.unknown);
  });
});

describe("countsByStatusForTutor — bucket totals match status totals", () => {
  it("per-status totals exclude the out-of-scope row", async () => {
    const c = await countsByStatusForTutor(TUTOR_ID);
    expect(c.pending).toBe(EXPECTED.pending.total);
    expect(c.approved).toBe(EXPECTED.approved.total);
    expect(c.rejected).toBe(EXPECTED.rejected.total);
  });

  it("byConfidence sums exactly to the status total for every status", async () => {
    const c = await countsByStatusForTutor(TUTOR_ID);
    expect(sumBuckets(c.byConfidence.pending)).toBe(c.pending);
    expect(sumBuckets(c.byConfidence.approved)).toBe(c.approved);
    expect(sumBuckets(c.byConfidence.rejected)).toBe(c.rejected);
  });

  it("places boundary confidence values into the documented buckets", async () => {
    const c = await countsByStatusForTutor(TUTOR_ID);
    // No out-of-scope row leaks in, so counts match EXPECTED exactly.
    expect(c.byConfidence.pending).toEqual({
      high: EXPECTED.pending.high,
      medium: EXPECTED.pending.medium,
      low: EXPECTED.pending.low,
      unknown: EXPECTED.pending.unknown,
    });
    expect(c.byConfidence.approved).toEqual({
      high: EXPECTED.approved.high,
      medium: EXPECTED.approved.medium,
      low: EXPECTED.approved.low,
      unknown: EXPECTED.approved.unknown,
    });
    expect(c.byConfidence.rejected).toEqual({
      high: EXPECTED.rejected.high,
      medium: EXPECTED.rejected.medium,
      low: EXPECTED.rejected.low,
      unknown: EXPECTED.rejected.unknown,
    });
  });

  it("returns all-zero counts (with zero buckets) for a tutor with no quizzes", async () => {
    const c = await countsByStatusForTutor(OTHER_TUTOR_ID);
    expect(c.pending).toBe(0);
    expect(c.approved).toBe(0);
    expect(c.rejected).toBe(0);
    expect(sumBuckets(c.byConfidence.pending)).toBe(0);
    expect(sumBuckets(c.byConfidence.approved)).toBe(0);
    expect(sumBuckets(c.byConfidence.rejected)).toBe(0);
  });
});
