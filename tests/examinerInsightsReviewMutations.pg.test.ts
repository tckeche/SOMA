/**
 * INTEGRATION TESTS — examiner-insights review-queue WRITE path against
 * a real Postgres.
 *
 * The sibling read-path file (`examinerInsightsReviewQueue.pg.test.ts`)
 * already proves the SELECT shape against PGlite. The mutation
 * functions — `approveInsight`, `rejectInsight`, `updateInsight`,
 * `bulkActionInsights`, and `bulkApproveHighConfidence` — were until
 * now only covered by SQL-string smoke checks. That meant a bad UPDATE
 * WHERE clause, a wrong `returning()` column (which would cause a
 * silent "skip" of cache invalidation), or a confidence threshold
 * off-by-one would slip through to production.
 *
 * This file boots the same in-process Postgres harness used by the
 * read-path file (via `tests/helpers/examinerInsightsReviewPgHarness`),
 * inserts per-test misconception rows, runs the mutation, and then
 * re-reads via `listQueue` to assert the row landed in the right
 * status with the right reviewer fields. The cache module is mocked
 * with spies so a missed `invalidateExaminerMisconceptionsCache` call
 * is caught explicitly.
 *
 * Hermetic: PGlite runs entirely in-process so CI needs no external
 * Postgres and tests do not flake on shared state.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@shared/schema";
import {
  applyMigrations,
  setupBaseFixtures,
  type BaseFixtureIds,
} from "./helpers/examinerInsightsReviewPgHarness";

let pglite: PGlite | null = null;
let testDb: PgliteDatabase<typeof schema> | null = null;
let base: BaseFixtureIds | null = null;

// Live-binding mock so the service under test sees our PGlite-backed
// `db`. The getter returns whatever `testDb` points to at call time,
// which lets the async beforeAll build the db before any test runs.
vi.mock("../server/db", () => ({
  get db() {
    return testDb;
  },
  pool: null,
  connectDb: async () => {},
}));

// Wrap the cache invalidator with a spy. We re-export the real
// implementation untouched so behaviour matches production; the spy
// only records calls so each mutation test can assert "yes, the cache
// was invalidated for this (board, syllabusCode)".
vi.mock("../server/services/examinerMisconceptionsCache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/services/examinerMisconceptionsCache")>();
  return {
    ...actual,
    invalidateExaminerMisconceptionsCache: vi.fn(
      actual.invalidateExaminerMisconceptionsCache,
    ),
  };
});

import { examinerMisconceptions } from "@shared/schema";
import { invalidateExaminerMisconceptionsCache } from "../server/services/examinerMisconceptionsCache";
import {
  approveInsight,
  bulkActionInsights,
  bulkApproveHighConfidence,
  listQueue,
  rejectInsight,
  updateInsight,
} from "../server/services/examinerInsightsReview";

const REVIEWER_ID = "00000000-0000-0000-0000-000000000020";

beforeAll(async () => {
  pglite = new PGlite();
  await applyMigrations(pglite);
  testDb = drizzlePglite(pglite, { schema });
  base = await setupBaseFixtures(testDb, { reviewerId: REVIEWER_ID });
}, 60_000);

afterAll(async () => {
  if (pglite) await pglite.close();
  pglite = null;
  testDb = null;
  base = null;
});

beforeEach(async () => {
  // Each write test starts from a clean slate: drop any rows the
  // previous test inserted, then reset the cache spy. The base
  // catalogue/users/documents seeded in beforeAll stay.
  if (testDb) {
    await testDb.delete(examinerMisconceptions);
  }
  vi.mocked(invalidateExaminerMisconceptionsCache).mockClear();
});

/**
 * Convenience: insert a single misconception row using sensible
 * defaults and return the inserted id. Tests override only the fields
 * relevant to the scenario being exercised.
 */
async function insertMisconception(
  overrides: Partial<typeof examinerMisconceptions.$inferInsert> = {},
): Promise<number> {
  if (!testDb || !base) throw new Error("harness not initialised");
  const [row] = await testDb
    .insert(examinerMisconceptions)
    .values({
      documentId: base.documentId,
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      subject: "Mathematics",
      topic: "Algebra",
      misconception: "default misconception",
      studentError: "default error",
      correctApproach: "default approach",
      frequency: "common",
      status: "pending",
      extractedAt: new Date("2026-04-01T10:00:00Z"),
      ...overrides,
    })
    .returning();
  return row.id;
}

/**
 * Convenience: read a single misconception back from the database by
 * id so write tests can assert the persisted row state without
 * routing through `listQueue`.
 */
async function readMisconception(id: number) {
  if (!testDb) throw new Error("testDb not initialised");
  const [row] = await testDb
    .select()
    .from(examinerMisconceptions)
    .where(eq(examinerMisconceptions.id, id));
  return row;
}

describe("approveInsight — executed against PGlite", () => {
  it("flips status to approved, stamps reviewer fields, and invalidates the cache", async () => {
    const id = await insertMisconception();

    await approveInsight(id, REVIEWER_ID, "looks fine");

    const row = await readMisconception(id);
    expect(row.status).toBe("approved");
    expect(row.reviewedById).toBe(REVIEWER_ID);
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewNotes).toBe("looks fine");

    // Cache must be invalidated for exactly this (board, syllabusCode)
    // — a missing returning() column would silently skip this call.
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledWith({
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
    });

    // Re-read through the service to prove the row now appears in the
    // approved bucket rather than the pending one.
    const approved = await listQueue({ status: "approved" });
    expect(approved.rows.map((r) => r.id)).toContain(id);
    const pending = await listQueue({ status: "pending" });
    expect(pending.rows.map((r) => r.id)).not.toContain(id);
  });

  it("stores null reviewNotes when notes are omitted", async () => {
    const id = await insertMisconception();

    await approveInsight(id, REVIEWER_ID);

    const row = await readMisconception(id);
    expect(row.reviewNotes).toBeNull();
    expect(row.status).toBe("approved");
  });

  it("does not touch other rows or invalidate caches when the id is unknown", async () => {
    const otherId = await insertMisconception({ misconception: "untouched" });

    await approveInsight(999_999, REVIEWER_ID, "noop");

    const untouched = await readMisconception(otherId);
    expect(untouched.status).toBe("pending");
    expect(untouched.reviewedById).toBeNull();
    // No row was returned by the UPDATE, so cache invalidation should not fire.
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();
  });
});

describe("rejectInsight — executed against PGlite", () => {
  it("flips status to rejected, stamps reviewer fields, and invalidates the cache", async () => {
    const id = await insertMisconception();

    await rejectInsight(id, REVIEWER_ID, "not a real misconception");

    const row = await readMisconception(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewedById).toBe(REVIEWER_ID);
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewNotes).toBe("not a real misconception");

    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledWith({
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
    });

    const rejected = await listQueue({ status: "rejected" });
    expect(rejected.rows.map((r) => r.id)).toContain(id);
  });

  it("does not touch other rows or invalidate caches when the id is unknown", async () => {
    const otherId = await insertMisconception();

    await rejectInsight(999_999, REVIEWER_ID);

    const untouched = await readMisconception(otherId);
    expect(untouched.status).toBe("pending");
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();
  });
});

describe("updateInsight — executed against PGlite", () => {
  it("applies partial patches to the targeted row only", async () => {
    const id = await insertMisconception({
      topic: "Algebra",
      subtopic: "Linear equations",
      misconception: "old",
      studentError: "old err",
      correctApproach: "old approach",
      frequency: "common",
      // Pre-existing reviewer state — content edits must not disturb it.
      status: "approved",
      reviewedById: REVIEWER_ID,
      reviewedAt: new Date("2026-01-01T00:00:00Z"),
      reviewNotes: "manually approved earlier",
    });
    const otherId = await insertMisconception({ misconception: "untouched" });

    await updateInsight(id, {
      misconception: "new misconception text",
      studentError: "new err",
      frequency: "rare",
    });

    const row = await readMisconception(id);
    expect(row.misconception).toBe("new misconception text");
    expect(row.studentError).toBe("new err");
    expect(row.frequency).toBe("rare");
    // Untouched fields stay as they were — this catches a bug where
    // the SET clause overwrites everything instead of just the patch.
    expect(row.topic).toBe("Algebra");
    expect(row.subtopic).toBe("Linear equations");
    expect(row.correctApproach).toBe("old approach");
    // Reviewer state is owned by approve/reject, not by content edits.
    // A regression that re-stamps reviewer fields on every PATCH would
    // corrupt the audit trail.
    expect(row.status).toBe("approved");
    expect(row.reviewedById).toBe(REVIEWER_ID);
    expect(row.reviewedAt?.toISOString()).toBe(
      new Date("2026-01-01T00:00:00Z").toISOString(),
    );
    expect(row.reviewNotes).toBe("manually approved earlier");

    const sibling = await readMisconception(otherId);
    expect(sibling.misconception).toBe("untouched");
  });

  it("links a row to a valid subtopic and unlinks it via subtopicId: null", async () => {
    if (!base) throw new Error("base fixtures missing");
    const id = await insertMisconception({ subtopicId: null });

    await updateInsight(id, { subtopicId: base.subtopicId });
    expect((await readMisconception(id)).subtopicId).toBe(base.subtopicId);

    await updateInsight(id, { subtopicId: null });
    expect((await readMisconception(id)).subtopicId).toBeNull();
  });

  it("is a no-op when the patch object is empty", async () => {
    const id = await insertMisconception({ misconception: "stays" });

    await updateInsight(id, {});

    const row = await readMisconception(id);
    expect(row.misconception).toBe("stays");
    expect(row.status).toBe("pending");
    // updateInsight intentionally does NOT touch the cache — only
    // approve/reject/bulk paths do — so we expect no calls regardless.
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();
  });

  it("allows clearing the free-text subtopic to null", async () => {
    const id = await insertMisconception({ subtopic: "old text" });

    await updateInsight(id, { subtopic: null });

    const row = await readMisconception(id);
    expect(row.subtopic).toBeNull();
  });
});

describe("bulkActionInsights — executed against PGlite", () => {
  it("approves every supplied id, returns the count, and invalidates the cache once per group", async () => {
    if (!base) throw new Error("base fixtures missing");
    const idA = await insertMisconception({ misconception: "row A" });
    const idB = await insertMisconception({ misconception: "row B" });
    // Out-of-scope syllabus row — proves cache invalidation groups by
    // (board, syllabusCode) and fires for each distinct group.
    const idC = await insertMisconception({
      documentId: base.otherDocumentId,
      syllabusCode: "0625",
      misconception: "row C on 0625",
    });

    const result = await bulkActionInsights(
      [idA, idB, idC],
      "approve",
      REVIEWER_ID,
      "bulk approved",
    );

    expect(result.updated).toBe(3);
    for (const id of [idA, idB, idC]) {
      const row = await readMisconception(id);
      expect(row.status).toBe("approved");
      expect(row.reviewedById).toBe(REVIEWER_ID);
      expect(row.reviewedAt).toBeInstanceOf(Date);
      expect(row.reviewNotes).toBe("bulk approved");
    }

    // Two distinct (board, syllabusCode) groups → exactly two cache
    // invalidations, deduped despite three rows being updated.
    const calls = vi.mocked(invalidateExaminerMisconceptionsCache).mock.calls;
    expect(calls).toHaveLength(2);
    const args = calls.map((c) => c[0]).sort((a, b) =>
      (a?.syllabusCode ?? "").localeCompare(b?.syllabusCode ?? ""),
    );
    expect(args).toEqual([
      { board: "Cambridge IGCSE", syllabusCode: "0580" },
      { board: "Cambridge IGCSE", syllabusCode: "0625" },
    ]);
  });

  it("rejects every supplied id with the same row-update + cache contract", async () => {
    const idA = await insertMisconception({ misconception: "row A" });
    const idB = await insertMisconception({ misconception: "row B" });

    const result = await bulkActionInsights(
      [idA, idB],
      "reject",
      REVIEWER_ID,
      "bulk rejected",
    );

    expect(result.updated).toBe(2);
    for (const id of [idA, idB]) {
      const row = await readMisconception(id);
      expect(row.status).toBe("rejected");
      expect(row.reviewNotes).toBe("bulk rejected");
    }
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledWith({
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
    });
  });

  it("dedupes ids and silently skips ids that don't match a row", async () => {
    const realId = await insertMisconception();

    const result = await bulkActionInsights(
      [realId, realId, 999_999],
      "approve",
      REVIEWER_ID,
    );

    // The real row was updated exactly once (dedup by id) and the bogus
    // id contributed nothing.
    expect(result.updated).toBe(1);
    const row = await readMisconception(realId);
    expect(row.status).toBe("approved");
  });

  it("returns {updated:0} and skips cache invalidation for an empty/invalid id list", async () => {
    const id = await insertMisconception();

    // Only invalid ids — none should touch any row.
    const result = await bulkActionInsights([0, -5, NaN], "approve", REVIEWER_ID);
    expect(result.updated).toBe(0);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();

    const empty = await bulkActionInsights([], "approve", REVIEWER_ID);
    expect(empty.updated).toBe(0);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();

    // Sentinel: the real row was never touched.
    const row = await readMisconception(id);
    expect(row.status).toBe("pending");
  });
});

describe("bulkApproveHighConfidence — executed against PGlite", () => {
  it("approves only rows at or above the default confidence threshold of 90", async () => {
    const idHigh1 = await insertMisconception({
      confidence: 95,
      misconception: "high 95",
    });
    // Boundary: 90 must be included (>= 90).
    const idHigh2 = await insertMisconception({
      confidence: 90,
      misconception: "boundary 90",
    });
    // Boundary minus one: 89 must NOT be included.
    const idMedium = await insertMisconception({
      confidence: 89,
      misconception: "medium 89",
    });
    const idLow = await insertMisconception({
      confidence: 10,
      misconception: "low 10",
    });
    const idNull = await insertMisconception({
      confidence: null,
      misconception: "no confidence",
    });

    const result = await bulkApproveHighConfidence(REVIEWER_ID);

    expect(result.approved).toBe(2);
    for (const id of [idHigh1, idHigh2]) {
      const row = await readMisconception(id);
      expect(row.status).toBe("approved");
      expect(row.reviewedById).toBe(REVIEWER_ID);
      // reviewedAt must be stamped — a regression that drops it would
      // leave an auto-approved row with no audit timestamp.
      expect(row.reviewedAt).toBeInstanceOf(Date);
      // Auto-approval stamps a deterministic note so reviewers can
      // distinguish auto-approvals from manual ones in the audit trail.
      expect(row.reviewNotes).toBe("auto-approved (confidence >= 90)");
    }
    for (const id of [idMedium, idLow, idNull]) {
      const row = await readMisconception(id);
      expect(row.status).toBe("pending");
      expect(row.reviewedById).toBeNull();
    }

    // One distinct (board, syllabusCode) group across all eligible
    // rows → exactly one cache invalidation.
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledWith({
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
    });
  });

  it("honours a caller-supplied minConfidence threshold and the boundary semantics", async () => {
    const idAt80 = await insertMisconception({ confidence: 80 });
    const idAt79 = await insertMisconception({ confidence: 79 });

    const result = await bulkApproveHighConfidence(REVIEWER_ID, {
      minConfidence: 80,
    });

    expect(result.approved).toBe(1);
    expect((await readMisconception(idAt80)).status).toBe("approved");
    expect((await readMisconception(idAt80)).reviewNotes).toBe(
      "auto-approved (confidence >= 80)",
    );
    expect((await readMisconception(idAt79)).status).toBe("pending");
  });

  it("scopes by board + syllabusCode and only invalidates cache for the targeted group", async () => {
    if (!base) throw new Error("base fixtures missing");
    const idIn = await insertMisconception({ confidence: 95 });
    const idOut = await insertMisconception({
      documentId: base.otherDocumentId,
      syllabusCode: "0625",
      confidence: 95,
    });

    const result = await bulkApproveHighConfidence(REVIEWER_ID, {
      syllabusCode: "0580",
    });

    expect(result.approved).toBe(1);
    expect((await readMisconception(idIn)).status).toBe("approved");
    // The 0625 row matched on confidence but was filtered out by
    // syllabusCode — it must remain pending.
    expect((await readMisconception(idOut)).status).toBe("pending");

    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledWith({
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
    });
  });

  it("ignores rows already approved or rejected so re-runs are idempotent", async () => {
    const idPending = await insertMisconception({ confidence: 99 });
    const idAlreadyApproved = await insertMisconception({
      confidence: 99,
      status: "approved",
      reviewedById: REVIEWER_ID,
      reviewedAt: new Date("2026-01-01T00:00:00Z"),
      reviewNotes: "manual approval",
    });

    const result = await bulkApproveHighConfidence(REVIEWER_ID);

    expect(result.approved).toBe(1);
    expect((await readMisconception(idPending)).status).toBe("approved");
    // The previously-approved row keeps its original manual note —
    // proves the WHERE clause filters status='pending' before writing.
    const stillManual = await readMisconception(idAlreadyApproved);
    expect(stillManual.status).toBe("approved");
    expect(stillManual.reviewNotes).toBe("manual approval");
  });

  it("returns {approved:0} and skips cache invalidation when nothing meets the threshold", async () => {
    await insertMisconception({ confidence: 10 });
    await insertMisconception({ confidence: null });

    const result = await bulkApproveHighConfidence(REVIEWER_ID);

    expect(result.approved).toBe(0);
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();
  });
});
