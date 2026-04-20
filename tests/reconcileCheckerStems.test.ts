import { describe, expect, it } from "vitest";
import {
  reconcileCheckerStems,
  type PipelineWarning,
  type QuizResult,
} from "../server/services/aiPipeline";

function q(stem: string, overrides: Partial<QuizResult["questions"][number]> = {}): QuizResult["questions"][number] {
  return {
    stem,
    options: ["A", "B", "C", "D"],
    correct_answer: "A",
    explanation: "Because.",
    marks: 1,
    ...overrides,
  };
}

describe("reconcileCheckerStems", () => {
  it("keeps checker output untouched when stems are identical", () => {
    const maker = [q("What is 2 + 2?")];
    const checker = [q("What is 2 + 2?", { correct_answer: "4", options: ["1", "2", "3", "4"] })];
    const { questions, driftWarnings } = reconcileCheckerStems(maker, checker, []);
    expect(questions).toEqual(checker);
    expect(driftWarnings).toEqual([]);
  });

  it("keeps checker output when the diff is pure LaTeX-wrapping (normalised form identical)", () => {
    const maker = [q("Differentiate x^2 with respect to x.")];
    const checker = [q("Differentiate $x^2$ with respect to $x$.")];
    const { questions, driftWarnings } = reconcileCheckerStems(maker, checker, []);
    expect(questions[0].stem).toBe("Differentiate $x^2$ with respect to $x$.");
    expect(driftWarnings).toEqual([]);
  });

  it("reverts to Maker stem when checker rewrote without a stem warning", () => {
    const maker = [q("What is the capital of Kenya?")];
    const checker = [q("Name the capital city of Kenya.", { correct_answer: "Nairobi" })];
    const { questions, driftWarnings } = reconcileCheckerStems(maker, checker, []);
    expect(questions[0].stem).toBe("What is the capital of Kenya?");
    expect(questions[0].correct_answer).toBe("Nairobi");
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0]).toMatchObject({
      questionIndex: 1,
      field: "stem",
      autoFixed: true,
    });
  });

  it("allows the rewrite when the checker flagged a stem warning for that index", () => {
    const maker = [q("Original stem with a $ bug")];
    const checker = [q("Corrected stem with 9 USD.")];
    const warnings: PipelineWarning[] = [
      { questionIndex: 1, field: "stem", issue: "currency $ fixed", autoFixed: true },
    ];
    const { questions, driftWarnings } = reconcileCheckerStems(maker, checker, warnings);
    expect(questions[0].stem).toBe("Corrected stem with 9 USD.");
    expect(driftWarnings).toEqual([]);
  });

  it("reverts only the drifted indices when multiple questions are present", () => {
    const maker = [q("Q1 original"), q("Q2 original"), q("Q3 original")];
    const checker = [q("Q1 original"), q("Q2 rewritten"), q("Q3 rewritten")];
    const warnings: PipelineWarning[] = [
      { questionIndex: 3, field: "stem", issue: "LaTeX fix", autoFixed: true },
    ];
    const { questions, driftWarnings } = reconcileCheckerStems(maker, checker, warnings);
    expect(questions[0].stem).toBe("Q1 original");
    expect(questions[1].stem).toBe("Q2 original"); // reverted — no warning
    expect(questions[2].stem).toBe("Q3 rewritten"); // allowed — warning exists
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0].questionIndex).toBe(2);
  });

  it("handles mismatched array lengths without throwing", () => {
    const maker = [q("Q1"), q("Q2")];
    const checker = [q("Q1")];
    const { questions, driftWarnings } = reconcileCheckerStems(maker, checker, []);
    expect(questions).toHaveLength(1);
    expect(driftWarnings).toEqual([]);
  });
});
