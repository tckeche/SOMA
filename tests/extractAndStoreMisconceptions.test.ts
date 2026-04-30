/**
 * Wires `extractAndStoreMisconceptions` end-to-end with mocked LLM,
 * storage, and resolver modules to assert that `resolveSubtopicId`'s
 * result is stamped onto every row passed to
 * `storage.createExaminerMisconceptions`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InsertExaminerMisconception } from "@shared/schema";
import type { ResolveSubtopicArgs, ResolveSubtopicResult } from "../server/services/subtopicResolver";

const {
  listExaminerMisconceptionsMock,
  createExaminerMisconceptionsMock,
  generateWithFallbackMock,
  resolveSubtopicIdMock,
  resolveSyllabusIdsForCodeMock,
} = vi.hoisted(() => ({
  listExaminerMisconceptionsMock: vi.fn(),
  createExaminerMisconceptionsMock: vi.fn<(rows: InsertExaminerMisconception[]) => Promise<InsertExaminerMisconception[]>>(),
  generateWithFallbackMock: vi.fn(),
  resolveSubtopicIdMock: vi.fn<(args: ResolveSubtopicArgs) => Promise<ResolveSubtopicResult>>(),
  resolveSyllabusIdsForCodeMock: vi.fn<(code: string | null | undefined) => Promise<number[]>>(),
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
