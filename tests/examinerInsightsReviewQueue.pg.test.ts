/**
 * INTEGRATION TESTS — examiner-insights review queue against a real Postgres.
 *
 * The sibling smoke test (`examinerInsightsReviewQueue.test.ts`) only
 * inspects the SQL strings drizzle emits. That catches *structural* bugs
 * (referencing a column without joining its table) but lets *semantic*
 * bugs through — wrong join key, wrong column type cast, missing GROUP
 * BY, scoping conditions that quietly let cross-tutor rows leak in,
 * etc. Those bugs only surface when the query actually runs.
 *
 * This file boots an in-process Postgres via PGlite, applies the
 * project's drizzle migrations end-to-end, seeds a small but
 * representative dataset, and then calls the public service entry
 * points. We assert *row content*, not just shape, so a regression that
 * e.g. swaps `subtopic_id` for `id` in the leftJoin condition shows up
 * as a wrong subtopicTitle / wrong row count instead of slipping past.
 *
 * Hermetic: PGlite runs entirely in-process so CI needs no external
 * Postgres and tests do not flake on shared state.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  mockServerDb,
  setupBaseFixtures,
  type TestDbHarness,
} from "./helpers/examinerInsightsReviewPgHarness";

let harness: TestDbHarness | null = null;

// Live-binding mock: the service accesses `db` inside each call, so the
// getter returns whatever `harness.db` points to at call time. This
// lets us build the PGlite-backed db asynchronously in beforeAll and
// still have the service pick it up.
vi.mock("../server/db", () => mockServerDb(() => harness?.db ?? null));

import { examinerMisconceptions } from "@shared/schema";

import {
  listQueue,
  listQueueForTutor,
  listSubtopicOptionsForInsight,
  SubtopicLinkValidationError,
  updateInsight,
} from "../server/services/examinerInsightsReview";

const TUTOR_ID = "00000000-0000-0000-0000-000000000010";
const REVIEWER_ID = "00000000-0000-0000-0000-000000000020";
const OTHER_TUTOR_ID = "00000000-0000-0000-0000-000000000030";

// IDs filled in during seeding so individual tests can assert against
// specific rows by primary key.
let SUBTOPIC_ID = 0;
let DOCUMENT_ID = 0;
let PENDING_LINKED_ID = 0;
let PENDING_UNLINKED_ID = 0;
let APPROVED_ID = 0;
let REJECTED_ID = 0;
let OUT_OF_SCOPE_PENDING_ID = 0;

beforeAll(async () => {
  harness = await createTestDb();
  const testDb = harness.db;

  const base = await setupBaseFixtures(testDb, {
    tutorId: TUTOR_ID,
    reviewerId: REVIEWER_ID,
    otherTutorId: OTHER_TUTOR_ID,
  });
  SUBTOPIC_ID = base.subtopicId;
  DOCUMENT_ID = base.documentId;
  const otherDoc = { id: base.otherDocumentId };

  // ---- Misconception rows: one per scenario the queue must handle ----
  // Pending + linked subtopic. Asserts the leftJoin actually hydrates
  // subtopicTitle from the subtopics row (not a stale free-text value).
  // extractedAt is set explicitly so ordering between rows is deterministic.
  const [pendingLinked] = await testDb
    .insert(examinerMisconceptions)
    .values({
      documentId: DOCUMENT_ID,
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      subject: "Mathematics",
      topic: "Algebra",
      subtopic: "Linear equations",
      subtopicId: SUBTOPIC_ID,
      misconception: "Treats the equation as an expression",
      studentError: "Drops the equals sign when solving",
      correctApproach: "Apply inverse operations to both sides",
      frequency: "common",
      status: "pending",
      sourceQuote: "candidates often dropped the equals sign",
      sourcePage: 12,
      confidence: 92,
      extractedAt: new Date("2026-04-01T10:00:00Z"),
    })
    .returning();
  PENDING_LINKED_ID = pendingLinked.id;

  // Pending + no subtopic_id. Asserts subtopicTitle is null and the
  // leftJoin doesn't drop the row.
  const [pendingUnlinked] = await testDb
    .insert(examinerMisconceptions)
    .values({
      documentId: DOCUMENT_ID,
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      subject: "Mathematics",
      topic: "Number",
      subtopicId: null,
      misconception: "Misreads decimals",
      studentError: "Treats 0.6 as smaller than 0.59",
      correctApproach: "Compare digit place values",
      frequency: "rare",
      status: "pending",
      confidence: 60,
      extractedAt: new Date("2026-03-01T10:00:00Z"),
    })
    .returning();
  PENDING_UNLINKED_ID = pendingUnlinked.id;

  // Approved row with reviewer fields populated, so the reviewer-name
  // join can be exercised (and reviewedAt round-trips through ISO).
  const [approved] = await testDb
    .insert(examinerMisconceptions)
    .values({
      documentId: DOCUMENT_ID,
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      topic: "Algebra",
      misconception: "Sign error on subtraction",
      studentError: "Drops the minus sign",
      correctApproach: "Track signs explicitly",
      frequency: "common",
      status: "approved",
      reviewedById: REVIEWER_ID,
      reviewedAt: new Date("2026-01-01T10:00:00Z"),
      reviewNotes: "looks good",
      extractedAt: new Date("2026-01-01T09:00:00Z"),
    })
    .returning();
  APPROVED_ID = approved.id;

  const [rejected] = await testDb
    .insert(examinerMisconceptions)
    .values({
      documentId: DOCUMENT_ID,
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      topic: "Algebra",
      misconception: "Bad row",
      studentError: "noise",
      correctApproach: "n/a",
      frequency: "rare",
      status: "rejected",
      reviewedById: REVIEWER_ID,
      reviewedAt: new Date("2026-02-01T10:00:00Z"),
      reviewNotes: "not a real misconception",
      extractedAt: new Date("2026-02-01T09:00:00Z"),
    })
    .returning();
  REJECTED_ID = rejected.id;

  // Out-of-scope pending row on syllabus 0625. Used to prove that the
  // tutor-scoped query filters it out and the unscoped query keeps it.
  const [outOfScope] = await testDb
    .insert(examinerMisconceptions)
    .values({
      documentId: otherDoc.id,
      board: "Cambridge IGCSE",
      syllabusCode: "0625",
      topic: "Forces",
      misconception: "Confuses mass with weight",
      studentError: "Reports kg as a force",
      correctApproach: "weight = mg, units N vs kg",
      frequency: "common",
      status: "pending",
      extractedAt: new Date("2026-03-15T10:00:00Z"),
    })
    .returning();
  OUT_OF_SCOPE_PENDING_ID = outOfScope.id;
}, 60_000);

afterAll(async () => {
  await harness?.teardown();
  harness = null;
});

describe("listQueue — executed against PGlite", () => {
  it("returns every pending row by default and hydrates the linked subtopic title", async () => {
    const { rows, total } = await listQueue();
    // Three pending rows across both seeded syllabi (0580 has two, 0625
    // has one). Approved + rejected rows must be excluded.
    expect(total).toBe(3);
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual(
      [PENDING_LINKED_ID, PENDING_UNLINKED_ID, OUT_OF_SCOPE_PENDING_ID].sort(
        (a, b) => a - b,
      ),
    );
    expect(ids).not.toContain(APPROVED_ID);
    expect(ids).not.toContain(REJECTED_ID);

    const linked = rows.find((r) => r.id === PENDING_LINKED_ID);
    expect(linked).toBeDefined();
    expect(linked!.subtopicId).toBe(SUBTOPIC_ID);
    // The whole point of the leftJoin: we get the catalogue row's title
    // back, not whatever free-text the extractor wrote into `subtopic`.
    expect(linked!.subtopicTitle).toBe("Place value");
    expect(linked!.documentFilename).toBe("cambridge-2024-er.pdf");
    expect(linked!.documentType).toBe("examiner_report");
    expect(linked!.confidencePct).toBe(92);
    expect(linked!.sourcePage).toBe(12);
    expect(linked!.misconception).toBe(
      "Treats the equation as an expression",
    );
    expect(linked!.reviewedById).toBeNull();
    expect(linked!.reviewedAt).toBeNull();
    expect(linked!.reviewedByDisplayName).toBeNull();

    const unlinked = rows.find((r) => r.id === PENDING_UNLINKED_ID);
    expect(unlinked).toBeDefined();
    expect(unlinked!.subtopicId).toBeNull();
    expect(unlinked!.subtopicTitle).toBeNull();
  });

  it("orders rows newest-extracted first", async () => {
    const { rows } = await listQueue();
    // extractedAt: pendingLinked = Apr 1, outOfScope = Mar 15,
    // pendingUnlinked = Mar 1. Default ORDER BY extracted_at DESC.
    expect(rows.map((r) => r.id)).toEqual([
      PENDING_LINKED_ID,
      OUT_OF_SCOPE_PENDING_ID,
      PENDING_UNLINKED_ID,
    ]);
  });

  it("filters to approved status and hydrates the reviewer's display name", async () => {
    const { rows, total } = await listQueue({ status: "approved" });
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(APPROVED_ID);
    expect(rows[0].status).toBe("approved");
    expect(rows[0].reviewedById).toBe(REVIEWER_ID);
    expect(rows[0].reviewedByDisplayName).toBe("Review Admin");
    expect(rows[0].reviewedAt).toBe(
      new Date("2026-01-01T10:00:00Z").toISOString(),
    );
    expect(rows[0].reviewNotes).toBe("looks good");
  });

  it("filters to rejected status", async () => {
    const { rows, total } = await listQueue({ status: "rejected" });
    expect(total).toBe(1);
    expect(rows[0].id).toBe(REJECTED_ID);
    expect(rows[0].status).toBe("rejected");
  });

  it("filters by syllabus code", async () => {
    const { rows, total } = await listQueue({ syllabusCode: "0625" });
    expect(total).toBe(1);
    expect(rows[0].id).toBe(OUT_OF_SCOPE_PENDING_ID);
    expect(rows[0].syllabusCode).toBe("0625");
  });

  it("respects limit + offset for pagination", async () => {
    const page1 = await listQueue({ limit: 1, offset: 0 });
    const page2 = await listQueue({ limit: 1, offset: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page2.rows).toHaveLength(1);
    expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
    // Total reflects the full filtered set (3 pending), not the page size.
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
  });
});

describe("listQueueForTutor — executed against PGlite", () => {
  it("returns only pending rows inside the tutor's syllabus scope", async () => {
    const { rows, total } = await listQueueForTutor(TUTOR_ID);
    expect(total).toBe(2);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(PENDING_LINKED_ID);
    expect(ids).toContain(PENDING_UNLINKED_ID);
    // The 0625 row is out of this tutor's scope and must not leak in.
    expect(ids).not.toContain(OUT_OF_SCOPE_PENDING_ID);
  });

  it("hydrates subtopicTitle for tutor-scoped rows", async () => {
    const { rows } = await listQueueForTutor(TUTOR_ID);
    const linked = rows.find((r) => r.id === PENDING_LINKED_ID);
    expect(linked).toBeDefined();
    expect(linked!.subtopicTitle).toBe("Place value");
    expect(linked!.documentFilename).toBe("cambridge-2024-er.pdf");
  });

  it("returns an empty list (not an error) for a tutor with no quizzes", async () => {
    const { rows, total } = await listQueueForTutor(OTHER_TUTOR_ID);
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });

  it("filters tutor-scoped queue by approved status", async () => {
    const { rows, total } = await listQueueForTutor(TUTOR_ID, {
      status: "approved",
    });
    expect(total).toBe(1);
    expect(rows[0].id).toBe(APPROVED_ID);
    expect(rows[0].reviewedByDisplayName).toBe("Review Admin");
  });

  it("filters tutor-scoped queue by rejected status", async () => {
    const { rows, total } = await listQueueForTutor(TUTOR_ID, {
      status: "rejected",
    });
    expect(total).toBe(1);
    expect(rows[0].id).toBe(REJECTED_ID);
  });
});

describe("listSubtopicOptionsForInsight — executed against PGlite", () => {
  it("returns the catalogue scoped to the row's syllabus and the resolver's best guess", async () => {
    // PENDING_LINKED_ID has free-text subtopic "Linear equations" but
    // the seeded catalogue only contains "Place value" — the resolver
    // can't match it, so suggestion is null. Options must still be
    // returned so the reviewer can pick from the syllabus catalogue.
    const result = await listSubtopicOptionsForInsight(PENDING_LINKED_ID);
    expect(result).not.toBeNull();
    expect(result!.insight.id).toBe(PENDING_LINKED_ID);
    expect(result!.insight.subtopicId).toBe(SUBTOPIC_ID);
    expect(result!.options).toHaveLength(1);
    expect(result!.options[0]).toMatchObject({
      id: SUBTOPIC_ID,
      title: "Place value",
      subtopicNumber: "1.1",
      topicNumber: "1",
      topicTitle: "Number basics",
    });
    // Suggestion is null when the free-text doesn't match any catalogue
    // title — the reviewer is asked to pick manually.
    expect(result!.suggestion).toBeNull();
  });

  it("returns an empty options list when the syllabus has no catalogue entries", async () => {
    // OUT_OF_SCOPE_PENDING_ID is on syllabus 0625 which we never seeded
    // catalogue rows for. The endpoint must still respond cleanly so
    // the picker UI can render an empty-state message.
    const result = await listSubtopicOptionsForInsight(OUT_OF_SCOPE_PENDING_ID);
    expect(result).not.toBeNull();
    expect(result!.options).toEqual([]);
    expect(result!.suggestion).toBeNull();
  });

  it("returns null for an unknown insight id", async () => {
    const result = await listSubtopicOptionsForInsight(999_999);
    expect(result).toBeNull();
  });

  it("rejects PATCH attempts that link an insight to an out-of-syllabus subtopic", async () => {
    // OUT_OF_SCOPE_PENDING_ID is on syllabus 0625; SUBTOPIC_ID belongs
    // to syllabus 0580. The PATCH layer should refuse this even though
    // the picker UI never offers it, so a hand-crafted request can't
    // quietly corrupt the catalogue link.
    await expect(
      updateInsight(OUT_OF_SCOPE_PENDING_ID, { subtopicId: SUBTOPIC_ID }),
    ).rejects.toBeInstanceOf(SubtopicLinkValidationError);
  });

  it("allows unlinking (subtopicId: null) without syllabus checks", async () => {
    if (!harness) throw new Error("harness not initialised");
    const testDb = harness.db;
    // Sanity check: PENDING_LINKED_ID starts linked.
    const before = await testDb
      .select({ subtopicId: examinerMisconceptions.subtopicId })
      .from(examinerMisconceptions)
      .where(eq(examinerMisconceptions.id, PENDING_LINKED_ID));
    expect(before[0].subtopicId).toBe(SUBTOPIC_ID);
    try {
      await updateInsight(PENDING_LINKED_ID, { subtopicId: null });
      const after = await testDb
        .select({ subtopicId: examinerMisconceptions.subtopicId })
        .from(examinerMisconceptions)
        .where(eq(examinerMisconceptions.id, PENDING_LINKED_ID));
      expect(after[0].subtopicId).toBeNull();
    } finally {
      // Restore so other tests in this file see the original linked state.
      await testDb
        .update(examinerMisconceptions)
        .set({ subtopicId: SUBTOPIC_ID })
        .where(eq(examinerMisconceptions.id, PENDING_LINKED_ID));
    }
  });

  it("surfaces the resolver's best guess when the free-text matches a catalogue title", async () => {
    // Insert a fresh row whose free-text subtopic exactly matches the
    // seeded catalogue entry — the resolver should pick "Place value".
    if (!harness) throw new Error("harness not initialised");
    const testDb = harness.db;
    const [row] = await testDb
      .insert(examinerMisconceptions)
      .values({
        documentId: DOCUMENT_ID,
        board: "Cambridge IGCSE",
        syllabusCode: "0580",
        subject: "Mathematics",
        topic: "Number basics",
        subtopic: "Place value",
        subtopicId: null,
        misconception: "Mixes units and tens",
        studentError: "Reads 12 as 21",
        correctApproach: "Identify each digit's place",
        frequency: "common",
        status: "pending",
        extractedAt: new Date("2026-04-15T10:00:00Z"),
      })
      .returning();
    try {
      const result = await listSubtopicOptionsForInsight(row.id);
      expect(result).not.toBeNull();
      expect(result!.suggestion).toEqual({
        id: SUBTOPIC_ID,
        title: "Place value",
      });
    } finally {
      await testDb
        .delete(examinerMisconceptions)
        .where(eq(examinerMisconceptions.id, row.id));
    }
  });
});
