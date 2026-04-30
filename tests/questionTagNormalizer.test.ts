import { describe, it, expect } from "vitest";
import { normalizeQuestionTag } from "../server/services/questionTagNormalizer";

describe("normalizeQuestionTag", () => {
  it.each([
    ["S-Writing.1", "Writing.1"],
    ["9.2 Algorithms", "Algorithms"],
    ["2 Algebra and graphs", "Algebra and graphs"],
    ["Pure Mathematics 1_Series", "Series"],
    ["E2.6 Inequalities Notes and examples [IGCSE/extended]", "Inequalities Notes and examples"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeQuestionTag(input)).toBe(expected);
  });

  it("returns null for empty-like input", () => {
    expect(normalizeQuestionTag(null)).toBeNull();
    expect(normalizeQuestionTag("   ")).toBeNull();
  });
});
