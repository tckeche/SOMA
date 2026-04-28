/**
 * AI PIPELINE TESTS (simplified 2-stage flow)
 * Covers: schema validation, happy path (Claude → ChatGPT), fallback path
 * (Claude fails → ChatGPT maker + Gemini verifier), verifier fallback
 * (ChatGPT verifier fails → Gemini verifier), PDF text extraction.
 *
 * The pipeline exposes a mutable `pipelineStages` object whose properties
 * tests reassign to stub each maker/verifier without module-level mocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  generateAuditedQuiz,
  parsePdfTextFromBuffer,
  QuestionSchema,
  QuizResultSchema,
  pipelineStages,
  validateAndCorrectMcqAnswers,
} from "../server/services/aiPipeline";

const validQuestion = {
  stem: "What is $2 + 2$?",
  options: ["2", "4", "6", "8"],
  correct_answer: "4",
  explanation: "Two plus two equals four. The distractors reflect common off-by-one errors.",
  marks: 1,
};

const validDraftQuestion = {
  stem: validQuestion.stem,
  options: validQuestion.options,
  correct_answer: validQuestion.correct_answer,
  marks: validQuestion.marks,
};

const originalStages = { ...pipelineStages };

function stubStages(overrides: Partial<typeof pipelineStages>) {
  Object.assign(pipelineStages, originalStages, overrides);
}

// ─── Schema tests ────────────────────────────────────────────────────────────
describe("QuestionSchema validation", () => {
  it("accepts a valid question", () => {
    expect(QuestionSchema.safeParse(validQuestion).success).toBe(true);
  });

  it("rejects fewer than 4 options", () => {
    expect(QuestionSchema.safeParse({ ...validQuestion, options: ["A", "B", "C"] }).success).toBe(false);
  });

  it("rejects more than 4 options", () => {
    expect(QuestionSchema.safeParse({ ...validQuestion, options: ["A", "B", "C", "D", "E"] }).success).toBe(false);
  });

  it("rejects marks outside 1-10", () => {
    expect(QuestionSchema.safeParse({ ...validQuestion, marks: 0 }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...validQuestion, marks: 11 }).success).toBe(false);
  });

  it("rejects non-integer marks", () => {
    expect(QuestionSchema.safeParse({ ...validQuestion, marks: 1.5 }).success).toBe(false);
  });

  it("accepts LaTeX notation in stem", () => {
    expect(
      QuestionSchema.safeParse({ ...validQuestion, stem: "Evaluate $\\int_0^1 x^2 \\, dx$" }).success,
    ).toBe(true);
  });
});

describe("QuizResultSchema validation", () => {
  it("accepts a valid quiz", () => {
    expect(QuizResultSchema.safeParse({ questions: [validQuestion] }).success).toBe(true);
  });

  it("rejects an empty questions array", () => {
    expect(QuizResultSchema.safeParse({ questions: [] }).success).toBe(false);
  });
});

// ─── Pipeline tests ──────────────────────────────────────────────────────────
describe("generateAuditedQuiz: happy path (Claude → ChatGPT)", () => {
  let mockClaudeMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIVerifier: ReturnType<typeof vi.fn>;
  let mockGeminiVerifier: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClaudeMaker = vi.fn().mockResolvedValue({ questions: [validDraftQuestion] });
    mockOpenAIMaker = vi.fn();
    mockOpenAIVerifier = vi.fn().mockResolvedValue({ questions: [validQuestion], warnings: [] });
    mockGeminiVerifier = vi.fn();
    stubStages({
      runClaudeMakerSimple: mockClaudeMaker,
      runOpenAIMakerSimple: mockOpenAIMaker,
      runOpenAIVerifier: mockOpenAIVerifier,
      runGeminiVerifier: mockGeminiVerifier,
    });
  });

  it("calls Claude maker then ChatGPT verifier exactly once each", async () => {
    await generateAuditedQuiz("Algebra");
    expect(mockClaudeMaker).toHaveBeenCalledTimes(1);
    expect(mockOpenAIVerifier).toHaveBeenCalledTimes(1);
    expect(mockGeminiVerifier).not.toHaveBeenCalled();
    expect(mockOpenAIMaker).not.toHaveBeenCalled();
  });

  it("returns the verified questions and correct telemetry", async () => {
    const result = await generateAuditedQuiz("Derivatives");
    expect(result.questions).toHaveLength(1);
    expect(result.telemetry.makerModel).toBe("anthropic/claude-sonnet-4-6");
    expect(result.telemetry.checkerModel).toBe("openai/gpt-4o");
  });

  it("surfaces warnings from the verifier", async () => {
    mockOpenAIVerifier.mockResolvedValue({
      questions: [validQuestion],
      warnings: [{ questionIndex: 1, field: "correct_answer", issue: "fixed wrong answer", autoFixed: true }],
    });
    const result = await generateAuditedQuiz("Calculus");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].autoFixed).toBe(true);
  });
});

describe("generateAuditedQuiz: Claude maker fails → ChatGPT maker + Gemini verifier", () => {
  let mockClaudeMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIVerifier: ReturnType<typeof vi.fn>;
  let mockGeminiVerifier: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClaudeMaker = vi.fn().mockRejectedValue(new Error("Anthropic unavailable"));
    mockOpenAIMaker = vi.fn().mockResolvedValue({ questions: [validDraftQuestion] });
    mockOpenAIVerifier = vi.fn();
    mockGeminiVerifier = vi.fn().mockResolvedValue({ questions: [validQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: mockClaudeMaker,
      runOpenAIMakerSimple: mockOpenAIMaker,
      runOpenAIVerifier: mockOpenAIVerifier,
      runGeminiVerifier: mockGeminiVerifier,
    });
  });

  it("falls back to ChatGPT maker + Gemini verifier", async () => {
    await generateAuditedQuiz("Trigonometry");
    expect(mockClaudeMaker).toHaveBeenCalledTimes(1);
    expect(mockOpenAIMaker).toHaveBeenCalledTimes(1);
    expect(mockGeminiVerifier).toHaveBeenCalledTimes(1);
    expect(mockOpenAIVerifier).not.toHaveBeenCalled();
  });

  it("reports tier-2 models in telemetry", async () => {
    const result = await generateAuditedQuiz("Probability");
    expect(result.telemetry.makerModel).toBe("openai/gpt-4o");
    expect(result.telemetry.checkerModel).toBe("google/gemini-2.5-flash");
  });
});

describe("generateAuditedQuiz: ChatGPT verifier fails → Gemini verifier", () => {
  let mockClaudeMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIVerifier: ReturnType<typeof vi.fn>;
  let mockGeminiVerifier: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClaudeMaker = vi.fn().mockResolvedValue({ questions: [validDraftQuestion] });
    mockOpenAIMaker = vi.fn();
    mockOpenAIVerifier = vi.fn().mockRejectedValue(new Error("OpenAI unavailable"));
    mockGeminiVerifier = vi.fn().mockResolvedValue({ questions: [validQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: mockClaudeMaker,
      runOpenAIMakerSimple: mockOpenAIMaker,
      runOpenAIVerifier: mockOpenAIVerifier,
      runGeminiVerifier: mockGeminiVerifier,
    });
  });

  it("uses Gemini as the verifier when ChatGPT verifier fails after Claude maker succeeded", async () => {
    const result = await generateAuditedQuiz("Statistics");
    expect(mockClaudeMaker).toHaveBeenCalledTimes(1);
    expect(mockOpenAIVerifier).toHaveBeenCalledTimes(1);
    expect(mockGeminiVerifier).toHaveBeenCalledTimes(1);
    expect(mockOpenAIMaker).not.toHaveBeenCalled();
    expect(result.telemetry.makerModel).toBe("anthropic/claude-sonnet-4-6");
    expect(result.telemetry.checkerModel).toBe("google/gemini-2.5-flash");
  });
});

describe("generateAuditedQuiz: error handling", () => {
  it("throws when both makers fail", async () => {
    stubStages({
      runClaudeMakerSimple: vi.fn().mockRejectedValue(new Error("Claude down")),
      runOpenAIMakerSimple: vi.fn().mockRejectedValue(new Error("OpenAI down")),
      runOpenAIVerifier: vi.fn(),
      runGeminiVerifier: vi.fn(),
    });
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow("OpenAI down");
  });

  it("throws when Claude makes but both verifiers fail", async () => {
    stubStages({
      runClaudeMakerSimple: vi.fn().mockResolvedValue({ questions: [validDraftQuestion] }),
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: vi.fn().mockRejectedValue(new Error("OpenAI verifier down")),
      runGeminiVerifier: vi.fn().mockRejectedValue(new Error("Gemini verifier down")),
    });
    await expect(generateAuditedQuiz("Topic")).rejects.toThrow("Gemini verifier down");
  });
});

describe("generateAuditedQuiz: batching", () => {
  let mockClaudeMaker: ReturnType<typeof vi.fn>;
  let mockOpenAIVerifier: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClaudeMaker = vi.fn().mockResolvedValue({ questions: [validDraftQuestion] });
    mockOpenAIVerifier = vi.fn().mockResolvedValue({ questions: [validQuestion], warnings: [] });
    stubStages({
      runClaudeMakerSimple: mockClaudeMaker,
      runOpenAIMakerSimple: vi.fn(),
      runOpenAIVerifier: mockOpenAIVerifier,
      runGeminiVerifier: vi.fn(),
    });
  });

  it("splits quizzes larger than 15 questions into batches", async () => {
    await generateAuditedQuiz({
      topic: "Algebra",
      subject: "Mathematics",
      syllabus: "Cambridge",
      level: "IGCSE",
      questionCount: 30,
    });
    // 30 questions → two batches of 15 → each batch = 1 maker + 1 verifier call
    expect(mockClaudeMaker).toHaveBeenCalledTimes(2);
    expect(mockOpenAIVerifier).toHaveBeenCalledTimes(2);
  });
});

// ─── Answer-key validator (the wrong-answer fix) ─────────────────────────────
describe("validateAndCorrectMcqAnswers", () => {
  const baseQ = {
    stem: "Find the derivative of e^(2x) sin(x).",
    options: [
      "$2e^{2x}\\sin x + e^{2x}\\cos x$",
      "$2e^{2x}\\sin x - e^{2x}\\cos x$",
      "$e^{2x}\\sin x + e^{2x}\\cos x$",
      "$2e^{2x}\\cos x$",
    ],
    correct_answer: "$2e^{2x}\\sin x + e^{2x}\\cos x$",
    explanation: "Product rule on e^(2x) and sin x.",
    marks: 2,
  };

  it("emits no warnings when correct_answer matches an option exactly", () => {
    const result = validateAndCorrectMcqAnswers([baseQ]);
    expect(result.warnings).toEqual([]);
    expect(result.questions[0].correct_answer).toBe(baseQ.correct_answer);
  });

  it("maps a bare letter ('B') to the correct option and emits an autoFixed warning", () => {
    const result = validateAndCorrectMcqAnswers([{ ...baseQ, correct_answer: "B" }]);
    expect(result.questions[0].correct_answer).toBe(baseQ.options[1]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      questionIndex: 1,
      field: "correct_answer",
      autoFixed: true,
    });
    expect(result.warnings[0].issue).toMatch(/bare letter/i);
  });

  it("normalises whitespace/case differences and emits an autoFixed warning", () => {
    const noisy = "  $2E^{2X}\\SIN X + E^{2X}\\COS X$  ";
    const result = validateAndCorrectMcqAnswers([{ ...baseQ, correct_answer: noisy }]);
    expect(result.questions[0].correct_answer).toBe(baseQ.options[0]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ autoFixed: true });
    expect(result.warnings[0].issue).toMatch(/whitespace\/case/i);
  });

  it("snaps a partial substring match and flags it for manual review (autoFixed)", () => {
    const partial = "$2e^{2x}\\sin x + e^{2x}\\cos x$ (by product rule)";
    const result = validateAndCorrectMcqAnswers([{ ...baseQ, correct_answer: partial }]);
    expect(result.questions[0].correct_answer).toBe(baseQ.options[0]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ autoFixed: true });
    expect(result.warnings[0].issue).toMatch(/partially matched/i);
  });

  it("emits a CRITICAL non-autoFixed warning when correct_answer matches NO option", () => {
    const garbage = "definitely not in the option list at all xyz123";
    const result = validateAndCorrectMcqAnswers([{ ...baseQ, correct_answer: garbage }]);
    expect(result.questions[0].correct_answer).toBe(baseQ.options[0]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      questionIndex: 1,
      field: "correct_answer",
      autoFixed: false,
    });
    expect(result.warnings[0].issue).toMatch(/CRITICAL/);
    expect(result.warnings[0].issue).toMatch(/REVIEW THIS QUESTION MANUALLY/);
  });

  it("preserves question indices when warnings span multiple questions", () => {
    const q1 = { ...baseQ, correct_answer: baseQ.options[0] };
    const q2 = { ...baseQ, correct_answer: "C" };
    const q3 = { ...baseQ, correct_answer: "totally bogus" };
    const result = validateAndCorrectMcqAnswers([q1, q2, q3]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].questionIndex).toBe(2);
    expect(result.warnings[0].autoFixed).toBe(true);
    expect(result.warnings[1].questionIndex).toBe(3);
    expect(result.warnings[1].autoFixed).toBe(false);
  });
});

// ─── PDF parsing (unchanged) ─────────────────────────────────────────────────
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
