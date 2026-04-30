/**
 * Wires `extractAndStoreMisconceptions` end-to-end with mocked LLM,
 * storage, and resolver modules to assert that `resolveSubtopicId`'s
 * result is stamped onto every row passed to
 * `storage.createExaminerMisconceptions`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InsertExaminerMisconception } from "@shared/schema";
import type { ResolveSubtopicArgs, ResolveSubtopicResult } from "../server/services/subtopicResolver";

import type { AllowedTopic } from "../server/services/catalogueInventory";

const {
  listExaminerMisconceptionsMock,
  createExaminerMisconceptionsMock,
  generateWithFallbackMock,
  resolveSubtopicIdMock,
  resolveSyllabusIdsForCodeMock,
  listAllowedTopicsForSyllabusCodeMock,
} = vi.hoisted(() => ({
  listExaminerMisconceptionsMock: vi.fn(),
  createExaminerMisconceptionsMock: vi.fn<(rows: InsertExaminerMisconception[]) => Promise<InsertExaminerMisconception[]>>(),
  generateWithFallbackMock: vi.fn(),
  resolveSubtopicIdMock: vi.fn<(args: ResolveSubtopicArgs) => Promise<ResolveSubtopicResult>>(),
  resolveSyllabusIdsForCodeMock: vi.fn<(code: string | null | undefined) => Promise<number[]>>(),
  listAllowedTopicsForSyllabusCodeMock: vi.fn<(code: string | null | undefined) => Promise<AllowedTopic[]>>(),
}));

vi.mock("../server/db", () => ({ db: {}, pool: null, connectDb: async () => {} }));

vi.mock("../server/storage", () => ({
  storage: {
    listExaminerMisconceptions: listExaminerMisconceptionsMock,
    createExaminerMisconceptions: createExaminerMisconceptionsMock,
  },
}));

vi.mock("../server/services/aiOrchestrator", () => ({
  generateWithFallback: generateWithFallbackMock,
}));

vi.mock("../server/services/subtopicResolver", () => ({
  resolveSubtopicId: resolveSubtopicIdMock,
  resolveSyllabusIdsForCode: resolveSyllabusIdsForCodeMock,
}));

vi.mock("../server/services/catalogueInventory", async () => {
  const actual = await vi.importActual<typeof import("../server/services/catalogueInventory")>(
    "../server/services/catalogueInventory",
  );
  return {
    ...actual,
    // Only the loader is mocked; `lookupInInventory` is pure logic and we
    // want the real implementation under test so the closed-set fast path
    // is exercised end-to-end.
    listAllowedTopicsForSyllabusCode: listAllowedTopicsForSyllabusCodeMock,
  };
});

import { extractAndStoreMisconceptions } from "../server/services/extractAndStoreMisconceptions";

// Quotes ≥ 15 chars satisfy the verbatim hallucination guard inside
// extractFromChunk; placing each quote inside its own `Question N`
// section coerces the structural chunker into producing one chunk per
// quote, so the LLM mock can return both items and have exactly one
// item survive the verbatim check per chunk.
const QUOTE_A =
  "Many candidates wrote that force equals mass instead of mass times acceleration";
const QUOTE_B =
  "Some students confused weight with mass when calculating gravitational force";
const EXTRACT_TEXT = `Question 1\n${QUOTE_A}.\n\nQuestion 2\n${QUOTE_B}.`;

function llmPayload(items: Array<Record<string, unknown>>) {
  return {
    data: JSON.stringify(items),
    metadata: { provider: "mock", model: "mock", durationMs: 1 },
  };
}

const ITEM_NEWTONS = {
  topic: "Mechanics",
  subtopic: "Newton's laws",
  misconception: "Students conflate force and mass.",
  studentError: "Wrote F=m instead of F=ma.",
  correctApproach: "Apply F=ma with consistent units.",
  frequency: "common",
  sourceQuote: QUOTE_A,
  confidencePct: 88,
};

const ITEM_WEIGHT = {
  topic: "Mechanics",
  subtopic: "Weight and mass",
  misconception: "Students conflate weight with mass.",
  studentError: "Used mass kg instead of weight N.",
  correctApproach: "Apply W=mg before substituting.",
  frequency: "occasional",
  sourceQuote: QUOTE_B,
  confidencePct: 80,
};

beforeEach(() => {
  listExaminerMisconceptionsMock.mockReset().mockResolvedValue([]);
  createExaminerMisconceptionsMock
    .mockReset()
    .mockImplementation(async (rows) => rows);
  generateWithFallbackMock.mockReset();
  resolveSubtopicIdMock.mockReset();
  resolveSyllabusIdsForCodeMock.mockReset().mockResolvedValue([1]);
  // Default: catalogue inventory empty → exercises the legacy
  // open-ended path so the original three tests below remain unchanged.
  listAllowedTopicsForSyllabusCodeMock.mockReset().mockResolvedValue([]);
});

describe("extractAndStoreMisconceptions at-insert subtopic resolution", () => {
  it("stamps the resolved subtopicId onto every row passed to storage.createExaminerMisconceptions", async () => {
    generateWithFallbackMock.mockResolvedValue(llmPayload([ITEM_NEWTONS, ITEM_WEIGHT]));
    resolveSubtopicIdMock.mockImplementation(async (args) => {
      if (args.subtopic === "Newton's laws") return { subtopicId: 42, ambiguous: false };
      if (args.subtopic === "Weight and mass") return { subtopicId: 99, ambiguous: false };
      return { subtopicId: null, ambiguous: false };
    });

    const result = await extractAndStoreMisconceptions({
      id: 7,
      board: "cambridge",
      syllabusCode: "9702",
      subject: "Physics",
      extractedText: EXTRACT_TEXT,
      filename: "9702_w24_er.pdf",
    });

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(2);

    expect(resolveSyllabusIdsForCodeMock).toHaveBeenCalledTimes(1);
    expect(resolveSyllabusIdsForCodeMock).toHaveBeenCalledWith("9702");
    expect(resolveSubtopicIdMock).toHaveBeenCalledTimes(2);
    for (const [args] of resolveSubtopicIdMock.mock.calls) {
      expect(args.candidateSyllabusIds).toEqual([1]);
      expect(args.subject).toBe("Physics");
      expect(args.topic).toBe("Mechanics");
    }

    expect(createExaminerMisconceptionsMock).toHaveBeenCalledTimes(1);
    const rows = createExaminerMisconceptionsMock.mock.calls[0][0];
    expect(rows).toHaveLength(2);

    const bySubtopic = new Map(rows.map((r) => [r.subtopic, r]));
    expect(bySubtopic.get("Newton's laws")?.subtopicId).toBe(42);
    expect(bySubtopic.get("Weight and mass")?.subtopicId).toBe(99);

    for (const row of rows) {
      expect(row.documentId).toBe(7);
      expect(row.board).toBe("cambridge");
      expect(row.syllabusCode).toBe("9702");
      expect(row.status).toBe("pending");
      expect(row.examYear).toBe(2024);
    }
  });

  it("leaves subtopicId null when the resolver reports ambiguous matches so the backfill can sweep them", async () => {
    generateWithFallbackMock.mockResolvedValue(llmPayload([ITEM_NEWTONS]));
    resolveSubtopicIdMock.mockResolvedValue({ subtopicId: null, ambiguous: true });

    const result = await extractAndStoreMisconceptions({
      id: 8,
      board: "cambridge",
      syllabusCode: "9702",
      subject: "Physics",
      extractedText: EXTRACT_TEXT,
      filename: null,
    });

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    expect(createExaminerMisconceptionsMock).toHaveBeenCalledTimes(1);
    const rows = createExaminerMisconceptionsMock.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].subtopicId).toBeNull();
    expect(rows[0].status).toBe("pending");
  });

  it("falls back to subtopicId=null when the resolver throws, without blocking the insert", async () => {
    generateWithFallbackMock.mockResolvedValue(llmPayload([ITEM_NEWTONS]));
    resolveSubtopicIdMock.mockRejectedValue(new Error("catalogue offline"));

    const result = await extractAndStoreMisconceptions({
      id: 9,
      board: "cambridge",
      syllabusCode: "9702",
      subject: "Physics",
      extractedText: EXTRACT_TEXT,
      filename: null,
    });

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    const rows = createExaminerMisconceptionsMock.mock.calls[0][0];
    expect(rows[0].subtopicId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 16: closed-set catalogue constraint
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNTING_INVENTORY: AllowedTopic[] = [
  {
    topicId: 11,
    topicTitle: "Double entry bookkeeping",
    subtopics: [
      { id: 111, title: "Source documents" },
      { id: 112, title: "Books of prime entry" },
    ],
  },
  {
    topicId: 12,
    topicTitle: "Trial balance",
    subtopics: [
      { id: 121, title: "Trial balance preparation" },
    ],
  },
];

// Items pinned to ACCOUNTING_INVENTORY entries — used by the closed-set
// tests so their `topic`/`subtopic` literals match the inventory verbatim.
const ITEM_BOOKKEEPING = {
  topic: "Double entry bookkeeping",
  subtopic: "Source documents",
  misconception: "Students record the wrong side of the entry.",
  studentError: "Debited revenue instead of crediting it.",
  correctApproach: "Apply the dual aspect rule consistently.",
  frequency: "common",
  sourceQuote: QUOTE_A,
  confidencePct: 86,
};

const ITEM_OFFLIST_ALGEBRA = {
  // The exact failure mode the legacy 3,485 rows show: an off-list math
  // topic hallucinated onto an Accounting paper.
  topic: "Algebra",
  subtopic: "Linear equations",
  misconception: "Students confuse like terms.",
  studentError: "Combined unlike terms in the expression.",
  correctApproach: "Group only matching variable powers.",
  frequency: "common",
  sourceQuote: QUOTE_B,
  confidencePct: 90,
};

const ITEM_TRIAL_BAD_SUBTOPIC = {
  // Topic is on-list, subtopic is invented. We expect the topic-level
  // signal to survive but the subtopic to be nulled (and subtopicId left
  // null since lookupInInventory returns subtopicId: null in this case).
  topic: "Trial balance",
  subtopic: "Loss-on-disposal reconciliation",
  misconception: "Students net debit and credit columns incorrectly.",
  studentError: "Subtracted debits from credits instead of comparing totals.",
  correctApproach: "Sum each column independently before comparing.",
  frequency: "occasional",
  sourceQuote: QUOTE_A,
  confidencePct: 75,
};

describe("extractAndStoreMisconceptions closed-set catalogue constraint", () => {
  it("drops items whose topic isn't in the catalogue inventory and reports the count via taxonomyDrops", async () => {
    listAllowedTopicsForSyllabusCodeMock.mockResolvedValue(ACCOUNTING_INVENTORY);
    generateWithFallbackMock.mockResolvedValue(
      llmPayload([ITEM_BOOKKEEPING, ITEM_OFFLIST_ALGEBRA]),
    );
    // Resolver should NOT be called for off-list items because they're
    // dropped before insert; but it IS called for the on-list item via
    // the fallback path when the inventory's subtopicId hit applies.

    const result = await extractAndStoreMisconceptions({
      id: 21,
      board: "Cambridge",
      syllabusCode: "9706",
      subject: "Accounting",
      extractedText: EXTRACT_TEXT,
      filename: "9706_w24_er.pdf",
    });

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    expect(result.taxonomyDrops).toBe(1);
    expect(result.closedSetTopicCount).toBe(2);

    expect(createExaminerMisconceptionsMock).toHaveBeenCalledTimes(1);
    const rows = createExaminerMisconceptionsMock.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe("Double entry bookkeeping");
    expect(rows[0].subtopic).toBe("Source documents");
    // Fast-path: subtopicId stamped directly from the inventory, no
    // resolver round-trip needed.
    expect(rows[0].subtopicId).toBe(111);
  });

  it("nulls out off-list subtopics while keeping the on-list topic, and falls through to the resolver for subtopicId", async () => {
    listAllowedTopicsForSyllabusCodeMock.mockResolvedValue(ACCOUNTING_INVENTORY);
    generateWithFallbackMock.mockResolvedValue(
      llmPayload([ITEM_TRIAL_BAD_SUBTOPIC]),
    );
    // The closed-set fast path returns `subtopicId: null` (topic matched,
    // subtopic didn't), so the resolver gets a chance to fuzzy-match.
    resolveSubtopicIdMock.mockResolvedValue({ subtopicId: 121, ambiguous: false });

    const result = await extractAndStoreMisconceptions({
      id: 22,
      board: "Cambridge",
      syllabusCode: "9706",
      subject: "Accounting",
      extractedText: EXTRACT_TEXT,
      filename: null,
    });

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    expect(result.taxonomyDrops).toBe(0);

    const rows = createExaminerMisconceptionsMock.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe("Trial balance");
    // Off-list subtopic is nulled rather than the whole row being dropped.
    expect(rows[0].subtopic).toBeNull();
    expect(rows[0].subtopicId).toBe(121);
    expect(resolveSubtopicIdMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the open-ended prompt when the inventory is empty, and reports closedSetTopicCount=0", async () => {
    // Inventory empty (default) → degraded path. The on-list-only items
    // we sent earlier wouldn't match anything in this codepath, so use
    // the original physics fixtures which carry valid sourceQuotes.
    listAllowedTopicsForSyllabusCodeMock.mockResolvedValue([]);
    generateWithFallbackMock.mockResolvedValue(llmPayload([ITEM_NEWTONS]));
    resolveSubtopicIdMock.mockResolvedValue({ subtopicId: 42, ambiguous: false });

    const result = await extractAndStoreMisconceptions({
      id: 23,
      board: "Cambridge",
      syllabusCode: "9999",
      subject: "Physics",
      extractedText: EXTRACT_TEXT,
      filename: null,
    });

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    expect(result.taxonomyDrops).toBe(0);
    expect(result.closedSetTopicCount).toBe(0);
    // No closed-set fast path → the resolver runs, even on items that
    // would have been off-list.
    expect(resolveSubtopicIdMock).toHaveBeenCalledTimes(1);
  });

  it("propagates chunkFailures so the re-extraction script can refuse to drop a sentinel on transient errors", async () => {
    // Every chunk's LLM call throws → extractFromChunk's catch block
    // increments chunkFailures and returns 0 items. Result must surface
    // skipped=true with reason='no-items' AND chunkFailures>0 so the
    // script's sentinel gate keeps the doc re-tryable instead of marking
    // it permanently done.
    listAllowedTopicsForSyllabusCodeMock.mockResolvedValue([]);
    generateWithFallbackMock.mockRejectedValue(new Error("simulated LLM 500"));

    const result = await extractAndStoreMisconceptions({
      id: 25,
      board: "Cambridge",
      syllabusCode: "9706",
      subject: "Accounting",
      extractedText: EXTRACT_TEXT,
      filename: null,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no-items");
    expect(result.count).toBe(0);
    expect(result.chunkFailures).toBeGreaterThan(0);
    expect(createExaminerMisconceptionsMock).not.toHaveBeenCalled();
  });

  it("skips the inventory lookup entirely when useStrictCatalogueConstraint=false", async () => {
    // Caller (e.g. legacy ingest path) explicitly opts out of the
    // closed-set constraint. We still expect old behaviour: the LLM is
    // called with the open-ended prompt and items pass through untouched.
    listAllowedTopicsForSyllabusCodeMock.mockRejectedValue(
      new Error("inventory loader should not have been called"),
    );
    generateWithFallbackMock.mockResolvedValue(llmPayload([ITEM_NEWTONS]));
    resolveSubtopicIdMock.mockResolvedValue({ subtopicId: 42, ambiguous: false });

    const result = await extractAndStoreMisconceptions(
      {
        id: 24,
        board: "Cambridge",
        syllabusCode: "9706",
        subject: "Accounting",
        extractedText: EXTRACT_TEXT,
        filename: null,
      },
      { useStrictCatalogueConstraint: false },
    );

    expect(result.skipped).toBe(false);
    expect(result.count).toBe(1);
    expect(result.closedSetTopicCount).toBe(0);
    expect(listAllowedTopicsForSyllabusCodeMock).not.toHaveBeenCalled();
  });
});
