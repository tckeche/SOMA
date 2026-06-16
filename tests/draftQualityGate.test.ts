import { describe, expect, it } from "vitest";
import type { DraftQuestion } from "@shared/schema";
import { evaluateDraftQuestionQuality } from "../client/src/lib/draftQualityGate";

function base(overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    draftId: "d1",
    stem: "What is 2 + 2?",
    options: ["3", "4", "5", "6"],
    correctAnswer: "4",
    explanation: "2 + 2 = 4.",
    marks: 1,
    questionType: "multiple_choice",
    topicTag: "Arithmetic",
    subtopicTag: "Addition",
    difficultyTag: "easy",
    ...overrides,
  };
}

describe("evaluateDraftQuestionQuality", () => {
  it("approves a clean draft question", () => {
    expect(evaluateDraftQuestionQuality(base()).status).toBe("ready");
  });

  it("blocks duplicate options and missing correct answers", () => {
    const result = evaluateDraftQuestionQuality(base({ options: ["3", "3", "5", "6"], correctAnswer: "4" }));
    expect(result.status).toBe("blocked");
    expect(result.issues.map((i) => i.message).join(" ")).toMatch(/duplicated|not one/);
  });

  it("warns without blocking when explanation or topic tags are missing", () => {
    const result = evaluateDraftQuestionQuality(base({ explanation: "", topicTag: null, subtopicTag: null }));
    expect(result.status).toBe("needs_review");
    expect(result.issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("blocks structured questions without a mark scheme", () => {
    const result = evaluateDraftQuestionQuality(base({ questionType: "structured", options: [], correctAnswer: "", markScheme: "" }));
    expect(result.status).toBe("blocked");
    expect(result.issues.map((i) => i.message).join(" ")).toMatch(/mark scheme/i);
  });
});
