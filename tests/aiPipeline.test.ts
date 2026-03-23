/**
 * AI PIPELINE (SOMA) TESTS
 * Tests the multi-agent quiz generation pipeline.
 * Covers: QuestionSchema validation, QuizResultSchema, 3-stage pipeline
 * (generate → math audit → syllabus audit), error propagation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock AI Orchestrator ─────────────────────────────────────────────────────
vi.mock("../server/services/aiOrchestrator", () => ({
  generateWithFallback: vi.fn(),
}));

import { generateWithFallback } from "../server/services/aiOrchestrator";
import { generateAuditedQuiz, parsePdfTextFromBuffer, QuestionSchema, QuizResultSchema } from "../server/services/aiPipeline";
import { z } from "zod";

const mockGenerateWithFallback = generateWithFallback as ReturnType<typeof vi.fn>;

// Valid sample quiz result JSON
const validQuizResult = {
  questions: [
    {
      stem: "What is $2 + 2$?",
      options: ["2", "4", "6", "8"],
      correct_answer: "4",
      explanation: "Basic addition: 2+2=4",
      marks: 1,
    },
    {
      stem: "Solve $x^2 = 9$",
      options: ["x=3", "x=±3", "x=9", "x=0"],
      correct_answer: "x=±3",
      explanation: "Square root of 9 is ±3",
      marks: 2,
    },
  ],
};

// ─── QuestionSchema Unit Tests ────────────────────────────────────────────────
describe("QuestionSchema validation", () => {
  it("accepts a valid question", () => {
    const result = QuestionSchema.safeParse(validQuizResult.questions[0]);
    expect(result.success).toBe(true);
  });

  it("rejects question with fewer than 4 options", () => {
    const result = QuestionSchema.safeParse({
      ...validQuizResult.questions[0],
      options: ["A", "B", "C"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects question with more than 4 options", () => {
    const result = QuestionSchema.safeParse({
      ...validQuizResult.questions[0],
      options: ["A", "B", "C", "D", "E"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects marks below 1", () => {
    const result = QuestionSchema.safeParse({ ...validQuizResult.questions[0], marks: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects marks above 10", () => {
    const result = QuestionSchema.safeParse({ ...validQuizResult.questions[0], marks: 11 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer marks", () => {
    const result = QuestionSchema.safeParse({ ...validQuizResult.questions[0], marks: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects missing stem", () => {
    const { stem, ...rest } = validQuizResult.questions[0];
    const result = QuestionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing correct_answer", () => {
    const { correct_answer, ...rest } = validQuizResult.questions[0];
    const result = QuestionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("accepts marks at boundary values (1 and 10)", () => {
    expect(QuestionSchema.safeParse({ ...validQuizResult.questions[0], marks: 1 }).success).toBe(true);
    expect(QuestionSchema.safeParse({ ...validQuizResult.questions[0], marks: 10 }).success).toBe(true);
  });

  it("accepts LaTeX notation in stem", () => {
    const result = QuestionSchema.safeParse({
      ...validQuizResult.questions[0],
      stem: "Evaluate \\(\\int_0^1 x^2 \\, dx\\)",
    });
    expect(result.success).toBe(true);
  });
});

// ─── QuizResultSchema Unit Tests ──────────────────────────────────────────────
describe("QuizResultSchema validation", () => {
  it("accepts valid quiz result", () => {
    const result = QuizResultSchema.safeParse(validQuizResult);
    expect(result.success).toBe(true);
  });

  it("rejects empty questions array", () => {
    const result = QuizResultSchema.safeParse({ questions: [] });
    expect(result.success).toBe(false);
  });

  it("rejects missing questions key", () => {
    const result = QuizResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects questions with invalid marks", () => {
    const result = QuizResultSchema.safeParse({
      questions: [{ ...validQuizResult.questions[0], marks: 99 }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts quiz with a single question", () => {
    const result = QuizResultSchema.safeParse({ questions: [validQuizResult.questions[0]] });
    expect(result.success).toBe(true);
  });
});

// ─── generateAuditedQuiz: Success path ───────────────────────────────────────
// generateWithFallback now returns { data: string, metadata: AIMetadata }
const makeAIResult = (data: string) => ({
  data,
  metadata: { provider: "mock", model: "mock-model", durationMs: 10 },
});

describe("generateAuditedQuiz: Full pipeline success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateWithFallback.mockResolvedValue(makeAIResult(JSON.stringify(validQuizResult)));
  });

  it("calls generateWithFallback 3 times (3 pipeline stages)", async () => {
    await generateAuditedQuiz("Algebra");
    expect(mockGenerateWithFallback).toHaveBeenCalledTimes(3);
  });

  it("returns a valid QuizResult object", async () => {
    const result = await generateAuditedQuiz("Derivatives");
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].stem).toBe("What is $2 + 2$?");
  });

  it("includes correct_answer in result", async () => {
    const result = await generateAuditedQuiz("Calculus");
    expect(result.questions[0].correct_answer).toBe("4");
  });

  it("includes explanation in result", async () => {
    const result = await generateAuditedQuiz("Trigonometry");
    expect(result.questions[0].explanation).toBeDefined();
  });

  it("first call prompt includes the topic", async () => {
    await generateAuditedQuiz("Quadratic Equations");
    const [, firstUserPrompt] = mockGenerateWithFallback.mock.calls[0];
    expect(firstUserPrompt).toMatch(/Quadratic Equations/i);
  });

  it("second call receives results from first stage", async () => {
    await generateAuditedQuiz("Statistics");
    // Second call should include the quiz data from step 1
    const [, secondUserPrompt] = mockGenerateWithFallback.mock.calls[1];
    expect(secondUserPrompt).toMatch(/Statistics/i);
  });

  it("third call receives results from second stage", async () => {
    await generateAuditedQuiz("Number Theory");
    const [, thirdUserPrompt] = mockGenerateWithFallback.mock.calls[2];
    expect(thirdUserPrompt).toMatch(/Number Theory/i);
  });

  it("each stage passes a schema to generateWithFallback", async () => {
    await generateAuditedQuiz("Probability");
    for (let i = 0; i < 3; i++) {
      expect(mockGenerateWithFallback.mock.calls[i][2]).toBeDefined();
    }
  });
});

// ─── generateAuditedQuiz: Error handling ─────────────────────────────────────
describe("generateAuditedQuiz: Error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when stage 1 fails (AI provider error)", async () => {
    mockGenerateWithFallback.mockRejectedValueOnce(new Error("All AI providers down"));
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow("All AI providers down");
  });

  it("throws when AI returns invalid JSON", async () => {
    mockGenerateWithFallback.mockResolvedValue(makeAIResult("not valid json at all!!!"));
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow();
  });

  it("throws when AI returns JSON that fails schema validation", async () => {
    mockGenerateWithFallback.mockResolvedValue(makeAIResult(JSON.stringify({
      questions: [{ stem: "Q?", options: ["A", "B"], correct_answer: "A", marks: 999 }],
    })));
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow();
  });

  it("throws when AI returns empty questions array", async () => {
    mockGenerateWithFallback.mockResolvedValue(makeAIResult(JSON.stringify({ questions: [] })));
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow();
  });

  it("throws when stage 2 fails after stage 1 succeeds", async () => {
    mockGenerateWithFallback
      .mockResolvedValueOnce(makeAIResult(JSON.stringify(validQuizResult)))
      .mockRejectedValueOnce(new Error("Stage 2 failed"));
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow("Stage 2 failed");
  });

  it("throws when stage 3 fails after stages 1-2 succeed", async () => {
    mockGenerateWithFallback
      .mockResolvedValueOnce(makeAIResult(JSON.stringify(validQuizResult)))
      .mockResolvedValueOnce(makeAIResult(JSON.stringify(validQuizResult)))
      .mockRejectedValueOnce(new Error("Stage 3 failed"));
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow("Stage 3 failed");
  });
});

// ─── Pipeline system prompt quality checks ────────────────────────────────────
describe("generateAuditedQuiz: System prompt content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateWithFallback.mockResolvedValue(makeAIResult(JSON.stringify(validQuizResult)));
  });

  it("stage 1 system prompt mentions 'expert mathematics'", async () => {
    await generateAuditedQuiz("Algebra");
    const [systemPrompt] = mockGenerateWithFallback.mock.calls[0];
    expect(systemPrompt.toLowerCase()).toMatch(/expert|mathematics|assessment/i);
  });

  it("stage 2 system prompt mentions 'audit' or 'accuracy'", async () => {
    await generateAuditedQuiz("Algebra");
    const [systemPrompt] = mockGenerateWithFallback.mock.calls[1];
    expect(systemPrompt.toLowerCase()).toMatch(/audit|accuracy|rigorous/i);
  });

  it("stage 3 system prompt mentions 'syllabus' or 'curriculum'", async () => {
    await generateAuditedQuiz("Algebra");
    const [systemPrompt] = mockGenerateWithFallback.mock.calls[2];
    expect(systemPrompt.toLowerCase()).toMatch(/syllabus|curriculum|compliance/i);
  });
});


describe("parsePdfTextFromBuffer", () => {
  it("extracts text from common Tj operators before falling back to raw latin1", async () => {
    const buffer = Buffer.from("BT (Question 1) Tj ET BT (Find x) Tj ET", "latin1");
    await expect(parsePdfTextFromBuffer(buffer)).resolves.toBe("Question 1 Find x");
  });

  it("extracts text from TJ arrays", async () => {
    const buffer = Buffer.from("BT [(Hello) 120 (World)] TJ ET", "latin1");
    await expect(parsePdfTextFromBuffer(buffer)).resolves.toBe("Hello World");
  });

  it("falls back to printable text when operators are absent", async () => {
    const buffer = Buffer.from("simple printable fallback", "latin1");
    await expect(parsePdfTextFromBuffer(buffer)).resolves.toBe("simple printable fallback");
  });
});
