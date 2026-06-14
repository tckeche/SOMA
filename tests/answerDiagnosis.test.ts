import { describe, expect, it } from "vitest";
import {
  resolveMisconceptionForWrongAnswer,
  type GradedAnswer,
} from "../server/services/answerDiagnosis";
import type { ExaminerMisconception } from "@shared/schema";

/**
 * Build a minimal ExaminerMisconception fixture. Only the fields the resolver
 * reads (id, misconception, studentError) carry meaning; the rest are filled
 * with throwaway values to satisfy the type.
 */
function misc(
  id: number,
  overrides: Partial<ExaminerMisconception> = {},
): ExaminerMisconception {
  return {
    id,
    documentId: 1,
    board: "CIE",
    syllabusCode: "0580",
    subject: "Mathematics",
    topic: "Algebra",
    subtopic: null,
    subtopicId: null,
    learningRequirementId: null,
    misconception: `Misconception ${id}`,
    studentError: `Student error ${id}`,
    correctApproach: "Do it correctly.",
    frequency: "common",
    status: "approved",
    reviewedById: null,
    reviewedAt: null,
    reviewNotes: null,
    sourceQuote: null,
    ...(overrides as object),
  } as ExaminerMisconception;
}

function mapOf(...rows: ExaminerMisconception[]): Map<number, ExaminerMisconception> {
  return new Map(rows.map((r) => [r.id, r]));
}

describe("resolveMisconceptionForWrongAnswer", () => {
  it("attributes EXACTLY via the chosen option's rationale id (no Jaccard)", () => {
    // Two candidates whose prose shares NO tokens with the option text "12",
    // so Jaccard could never match. The rationale for option "12" names id 7.
    const candidates = mapOf(
      misc(7, { misconception: "Forgets to distribute the negative sign across brackets" }),
      misc(9, { misconception: "Adds exponents when multiplying unlike bases" }),
    );
    const optionRationales: GradedAnswer["optionRationales"] = [
      { option: "12", isCorrect: false, rationale: "wrong", misconceptionId: 7 },
      { option: "6", isCorrect: true, rationale: "right", misconceptionId: null },
    ];

    const resolved = resolveMisconceptionForWrongAnswer("12", optionRationales, candidates);
    expect(resolved).not.toBeNull();
    expect(resolved!.exact).toBe(true);
    expect(resolved!.category).toBe("matched_misconception");
    expect(resolved!.row.id).toBe(7);
  });

  it("trims whitespace when matching the option text", () => {
    const candidates = mapOf(misc(3, { misconception: "Off-by-one error" }));
    const optionRationales: GradedAnswer["optionRationales"] = [
      { option: "x=3", isCorrect: false, rationale: "wrong", misconceptionId: 3 },
    ];
    const resolved = resolveMisconceptionForWrongAnswer("  x=3 ", optionRationales, candidates);
    expect(resolved!.exact).toBe(true);
    expect(resolved!.row.id).toBe(3);
  });

  it("falls back to Jaccard for legacy questions (optionRationales null)", () => {
    // No rationales — must use token similarity over candidate prose.
    const candidates = mapOf(
      misc(11, {
        misconception: "Confuses perimeter with area of a rectangle",
        studentError: "computes perimeter when the question asks for area rectangle",
      }),
      misc(12, { misconception: "Rounds before the final step", studentError: "rounds early" }),
    );
    const resolved = resolveMisconceptionForWrongAnswer(
      "Area of the rectangle perimeter computed",
      null,
      candidates,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.exact).toBe(false);
    expect(resolved!.row.id).toBe(11);
  });

  it("falls back to Jaccard when a rationale has a null misconceptionId", () => {
    const candidates = mapOf(
      misc(21, {
        misconception: "Sign error",
        studentError: "drops the negative sign during subtraction operation",
      }),
    );
    const optionRationales: GradedAnswer["optionRationales"] = [
      { option: "-5", isCorrect: false, rationale: "wrong", misconceptionId: null },
    ];
    // Option text "-5" tokenises to nothing useful, so this stays unmatched —
    // proving the exact gate did NOT fire (no id) and Jaccard ran.
    const resolved = resolveMisconceptionForWrongAnswer("-5", optionRationales, candidates);
    expect(resolved).toBeNull();
  });

  it("falls back to Jaccard when the rationale id is absent from the candidate map", () => {
    // Rationale names id 99 but it was never loaded (e.g. outside target set and
    // not fetched). Exact gate cannot resolve → Jaccard over what we have.
    const candidates = mapOf(
      misc(31, {
        misconception: "Wrong formula",
        studentError: "applies the speed distance time formula incorrectly here",
      }),
    );
    const optionRationales: GradedAnswer["optionRationales"] = [
      { option: "42", isCorrect: false, rationale: "wrong", misconceptionId: 99 },
    ];
    const resolved = resolveMisconceptionForWrongAnswer(
      "speed distance time formula applied incorrectly",
      optionRationales,
      candidates,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.exact).toBe(false);
    expect(resolved!.row.id).toBe(31);
  });
});
