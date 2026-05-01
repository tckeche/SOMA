/**
 * INTEGRATION TESTS — `triagePendingMisconceptions` against an
 * in-process Postgres (PGlite). Verifies the tiered triage logic
 * approves rows that clear ALL hard signals, rejects rows that fail any
 * hard signal, leaves the ambiguous middle tier as `pending`, stamps
 * the right reviewNotes per rule, invalidates caches per affected
 * (board, syllabusCode) group, and respects --dry-run by writing
 * nothing.
 *
 * Reuses the same PGlite harness that the read-path / mutation-path
 * tests use, so the catalogue chain, users, and source documents are
 * seeded the same way.
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
import { eq } from "drizzle-orm";
import {
  createTestDb,
  mockServerDb,
  setupBaseFixtures,
  type BaseFixtureIds,
  type TestDbHarness,
} from "./helpers/examinerInsightsReviewPgHarness";

let harness: TestDbHarness | null = null;
let base: BaseFixtureIds | null = null;

vi.mock("../server/db", () => mockServerDb(() => harness?.db ?? null));

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
import { triagePendingMisconceptions } from "../server/services/examinerInsightsReview";

const REVIEWER_ID = "00000000-0000-0000-0000-000000000020";

beforeAll(async () => {
  harness = await createTestDb();
  base = await setupBaseFixtures(harness.db, { reviewerId: REVIEWER_ID });
}, 60_000);

afterAll(async () => {
  await harness?.teardown();
  harness = null;
  base = null;
});

beforeEach(async () => {
  if (harness) {
    await harness.db.delete(examinerMisconceptions);
  }
  vi.mocked(invalidateExaminerMisconceptionsCache).mockClear();
});

interface RowOverrides {
  status?: "pending" | "approved" | "rejected";
  confidence?: number | null;
  subtopicId?: number | null;
  sourceQuote?: string | null;
  frequency?: string;
  board?: string;
  syllabusCode?: string;
  documentId?: number;
}

async function insertMisconception(overrides: RowOverrides = {}): Promise<number> {
  if (!harness || !base) throw new Error("harness not initialised");
  const [row] = await harness.db
    .insert(examinerMisconceptions)
    .values({
      documentId: overrides.documentId ?? base.documentId,
      board: overrides.board ?? "Cambridge IGCSE",
      syllabusCode: overrides.syllabusCode ?? "0580",
      subject: "Mathematics",
      topic: "Algebra",
      misconception: "default",
      studentError: "default",
      correctApproach: "default",
      frequency: overrides.frequency ?? "common",
      status: overrides.status ?? "pending",
      confidence: overrides.confidence === undefined ? 80 : overrides.confidence,
      sourceQuote:
        overrides.sourceQuote === undefined ? "verbatim quote from report" : overrides.sourceQuote,
      subtopicId: overrides.subtopicId === undefined ? base.subtopicId : overrides.subtopicId,
      extractedAt: new Date("2026-04-01T10:00:00Z"),
    })
    .returning();
  return row.id;
}

async function readMisconception(id: number) {
  if (!harness) throw new Error("harness not initialised");
  const [row] = await harness.db
    .select()
    .from(examinerMisconceptions)
    .where(eq(examinerMisconceptions.id, id));
  return row;
}

describe("triagePendingMisconceptions — tiered automated triage", () => {
  it("auto-approves rows that clear all hard signals (high conf + linked + quote + freq)", async () => {
    const id = await insertMisconception({
      confidence: 85,
      frequency: "very_common",
      sourceQuote: "students often wrote 2x+3 = 7 instead of 2x = 4",
    });

    const result = await triagePendingMisconceptions();

    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.leftPending).toBe(0);
    expect(result.approvedIds).toEqual([id]);

    const row = await readMisconception(id);
    expect(row.status).toBe("approved");
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewedById).toBeNull(); // automated → no human reviewer
    expect(row.reviewNotes).toMatch(/^auto-approved:/);
    expect(row.reviewNotes).toContain("confidence>=70");
    expect(row.reviewNotes).toContain("linked subtopic");
    expect(row.reviewNotes).toContain("has source_quote");

    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).toHaveBeenCalledWith({
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
    });
  });

  it("auto-rejects rows missing source_quote (the legacy hallucination signal)", async () => {
    const id = await insertMisconception({
      confidence: 85,
      sourceQuote: null,
    });

    const result = await triagePendingMisconceptions();

    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.rejectedIds).toEqual([id]);

    const row = await readMisconception(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewNotes).toBe("auto-rejected: missing source_quote");
  });

  it("auto-rejects rows below the reject confidence threshold", async () => {
    const id = await insertMisconception({ confidence: 20 });

    const result = await triagePendingMisconceptions();

    expect(result.rejected).toBe(1);
    const row = await readMisconception(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewNotes).toBe("auto-rejected: confidence<40");
  });

  it("combines reject reasons when a row fails multiple hard signals", async () => {
    const id = await insertMisconception({ confidence: 10, sourceQuote: null });

    await triagePendingMisconceptions();

    const row = await readMisconception(id);
    expect(row.status).toBe("rejected");
    expect(row.reviewNotes).toContain("confidence<40");
    expect(row.reviewNotes).toContain("missing source_quote");
  });

  it("leaves the ambiguous middle tier as pending (e.g. confidence 50, no FK)", async () => {
    const id = await insertMisconception({
      confidence: 50,
      subtopicId: null,
    });

    const result = await triagePendingMisconceptions();

    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.leftPending).toBe(1);
    expect(result.leftPendingIds).toEqual([id]);

    const row = await readMisconception(id);
    expect(row.status).toBe("pending"); // untouched
    expect(row.reviewedAt).toBeNull();
    expect(row.reviewNotes).toBeNull();
  });

  it("does not auto-approve rows with a frequency outside the approve set", async () => {
    const id = await insertMisconception({ frequency: "occasional" });

    const result = await triagePendingMisconceptions();

    expect(result.approved).toBe(0);
    expect(result.leftPending).toBe(1);
    const row = await readMisconception(id);
    expect(row.status).toBe("pending");
  });

  it("does not auto-approve rows missing the subtopic FK", async () => {
    const id = await insertMisconception({ subtopicId: null });

    const result = await triagePendingMisconceptions();

    expect(result.approved).toBe(0);
    expect(result.leftPending).toBe(1);
    const row = await readMisconception(id);
    expect(row.status).toBe("pending");
  });

  it("treats null confidence as 0 — pure null rows are rejected on confidence floor", async () => {
    const id = await insertMisconception({ confidence: null });

    const result = await triagePendingMisconceptions();

    expect(result.rejected).toBe(1);
    const row = await readMisconception(id);
    expect(row.status).toBe("rejected");
  });

  it("never touches already-approved or already-rejected rows", async () => {
    const approvedId = await insertMisconception({ status: "approved", confidence: 90 });
    const rejectedId = await insertMisconception({ status: "rejected", confidence: 10 });

    const result = await triagePendingMisconceptions();

    expect(result.scanned).toBe(0);
    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(0);

    const approved = await readMisconception(approvedId);
    const rejected = await readMisconception(rejectedId);
    expect(approved.status).toBe("approved");
    expect(rejected.status).toBe("rejected");
  });

  it("dry-run reports counts without writing or invalidating caches", async () => {
    const approveId = await insertMisconception({ confidence: 90, frequency: "very_common" });
    const rejectId = await insertMisconception({ confidence: 10 });

    const result = await triagePendingMisconceptions({ dryRun: true });

    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.approvedIds).toEqual([approveId]);
    expect(result.rejectedIds).toEqual([rejectId]);

    // No DB writes:
    const approveRow = await readMisconception(approveId);
    const rejectRow = await readMisconception(rejectId);
    expect(approveRow.status).toBe("pending");
    expect(rejectRow.status).toBe("pending");

    // No cache invalidation:
    expect(vi.mocked(invalidateExaminerMisconceptionsCache)).not.toHaveBeenCalled();
  });

  it("scopes triage to a single syllabus code when provided", async () => {
    if (!base) throw new Error("base fixtures missing");
    const inScope = await insertMisconception({
      syllabusCode: "0580",
      confidence: 90,
      frequency: "very_common",
    });
    const outOfScope = await insertMisconception({
      syllabusCode: "0625",
      documentId: base.otherDocumentId,
      confidence: 90,
      frequency: "very_common",
      // 0625 has no subtopic in the seeded catalogue, so we deliberately
      // leave the FK null — that also keeps the test from approving it
      // accidentally if the scope filter regressed.
      subtopicId: null,
    });

    const result = await triagePendingMisconceptions({ syllabusCode: "0580" });

    expect(result.scanned).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.approvedIds).toEqual([inScope]);

    const otherRow = await readMisconception(outOfScope);
    expect(otherRow.status).toBe("pending"); // untouched
  });

  it("stamps the supplied reviewerId when one is provided", async () => {
    const id = await insertMisconception({ confidence: 90, frequency: "very_common" });

    await triagePendingMisconceptions({ reviewerId: REVIEWER_ID });

    const row = await readMisconception(id);
    expect(row.reviewedById).toBe(REVIEWER_ID);
  });

  it("respects custom thresholds — raising minApproveConfidence demotes a row to pending", async () => {
    const id = await insertMisconception({ confidence: 75, frequency: "common" });

    const result = await triagePendingMisconceptions({ minApproveConfidence: 90 });

    expect(result.approved).toBe(0);
    expect(result.leftPending).toBe(1);
    const row = await readMisconception(id);
    expect(row.status).toBe("pending");
  });

  it("respects --no-require-source-quote — high-confidence row with null quote can still be approved", async () => {
    const id = await insertMisconception({
      confidence: 90,
      frequency: "very_common",
      sourceQuote: null,
    });

    const result = await triagePendingMisconceptions({
      requireSourceQuote: false,
    });

    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(0);
    const row = await readMisconception(id);
    expect(row.status).toBe("approved");
  });

  it("processes a mixed batch and writes one UPDATE per status group with correct reviewNotes", async () => {
    const approveId = await insertMisconception({ confidence: 95, frequency: "very_common" });
    const rejectMissingQuoteId = await insertMisconception({ confidence: 95, sourceQuote: null });
    const rejectLowConfId = await insertMisconception({ confidence: 5 });
    const pendingId = await insertMisconception({ confidence: 50, subtopicId: null });

    const result = await triagePendingMisconceptions();

    expect(result.scanned).toBe(4);
    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(2);
    expect(result.leftPending).toBe(1);

    const a = await readMisconception(approveId);
    const r1 = await readMisconception(rejectMissingQuoteId);
    const r2 = await readMisconception(rejectLowConfId);
    const p = await readMisconception(pendingId);

    expect(a.status).toBe("approved");
    expect(r1.status).toBe("rejected");
    expect(r1.reviewNotes).toBe("auto-rejected: missing source_quote");
    expect(r2.status).toBe("rejected");
    expect(r2.reviewNotes).toBe("auto-rejected: confidence<40");
    expect(p.status).toBe("pending");

    // Cache invalidation runs once per affected (board, syllabusCode) group
    // — all four rows share Cambridge IGCSE / 0580.
    const calls = vi.mocked(invalidateExaminerMisconceptionsCache).mock.calls;
    const uniqueGroups = new Set(calls.map((c) => `${c[0].board}|${c[0].syllabusCode}`));
    expect(uniqueGroups).toEqual(new Set(["Cambridge IGCSE|0580"]));
  });
});
