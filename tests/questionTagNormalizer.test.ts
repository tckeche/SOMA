import { describe, it, expect } from "vitest";
import { normalizeQuestionTag } from "../server/services/questionTagNormalizer";

describe("normalizeQuestionTag", () => {
  it.each([
    // Examples from task #25.
    ["S-Writing.1", "Writing"],
    ["9.2 Algorithms", "Algorithms"],
    ["2 Algebra and graphs", "Algebra and graphs"],
    ["Pure Mathematics 1_Series", "Series"],
    ["E2.6 Inequalities Notes and examples [IGCSE/extended]", "Inequalities"],
    // Composite "topic, subtopic" packed into one field.
    ["Describe a species as a group of organisms, Cell structure", "Cell structure"],
    [
      "Characteristics and classification of living organisms, Concept and uses of classification systems",
      "Concept and uses of classification systems",
    ],
    // Bracketed/parenthesised annotations.
    ["Forces (Higher)", "Forces"],
    ["Algorithms {paper 1}", "Algorithms"],
    // Trailing boilerplate.
    ["Inequalities Notes", "Inequalities"],
    ["Series Notes & examples", "Series"],
    // Already-clean strings pass through unchanged (idempotency).
    ["Mechanics", "Mechanics"],
    ["Newton's third law", "Newton's third law"],
    ["Stoichiometry & moles", "Stoichiometry & moles"],
    ["Atomic structure", "Atomic structure"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeQuestionTag(input)).toBe(expected);
  });

  it("returns null for empty-like input", () => {
    expect(normalizeQuestionTag(null)).toBeNull();
    expect(normalizeQuestionTag(undefined)).toBeNull();
    expect(normalizeQuestionTag("")).toBeNull();
    expect(normalizeQuestionTag("   ")).toBeNull();
  });

  it("is idempotent — running twice yields the same result", () => {
    const inputs = [
      "S-Writing.1",
      "9.2 Algorithms",
      "Pure Mathematics 1_Series",
      "E2.6 Inequalities Notes and examples [IGCSE/extended]",
    ];
    for (const raw of inputs) {
      const once = normalizeQuestionTag(raw);
      const twice = normalizeQuestionTag(once);
      expect(twice).toBe(once);
    }
  });
});
