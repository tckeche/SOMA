/**
 * Unit tests — pure matcher in `learningRequirementResolver`.
 *
 * Covers the public contract used by the backfill script:
 *   - `tokenize` strips punctuation, lowercases, drops stop-words and
 *     too-short tokens.
 *   - `jaccard` returns 0 on empty sets and 1 on identical sets.
 *   - `pickBestRequirement` returns null with an explanatory reason
 *     when (a) no candidates exist, (b) no candidate clears the
 *     minScore floor, or (c) the top match doesn't beat the runner-up
 *     by minScoreGap. Otherwise returns the top requirement id.
 *
 * The DB-backed `backfillLearningRequirementLinks` wrapper is
 * exercised through the matcher's contract here; an end-to-end PGlite
 * integration test would be the next layer up if the matcher's
 * accuracy ever needs a regression net.
 */
import { describe, it, expect } from "vitest";
import {
  tokenize,
  jaccard,
  pickBestRequirement,
} from "../server/services/learningRequirementResolver";

describe("tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenize("Solving Linear Equations!")).toEqual(["solving", "linear", "equations"]);
  });

  it("drops stop-words and very short tokens", () => {
    expect(tokenize("The candidate is solving an equation")).toEqual(["solving", "equation"]);
  });

  it("returns [] on empty / whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("preserves math vocabulary even when generic words around it are stripped", () => {
    const toks = tokenize("Students often forget to apply the chain rule when differentiating");
    expect(toks).toContain("forget");
    expect(toks).toContain("apply");
    expect(toks).toContain("chain");
    expect(toks).toContain("rule");
    expect(toks).toContain("differentiating");
    // Stop-words gone:
    expect(toks).not.toContain("often");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("to");
    expect(toks).not.toContain("students");
  });
});

describe("jaccard", () => {
  it("returns 0 on empty inputs", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard([], [])).toBe(0);
  });

  it("returns 1 on identical sets", () => {
    expect(jaccard(["solve", "equation"], ["solve", "equation"])).toBe(1);
  });

  it("computes correct ratio for partial overlap", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} → 2 ; ∪ → {a,b,c,d} → 4 ; jaccard = 0.5
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });

  it("treats duplicates as a set", () => {
    expect(jaccard(["a", "a", "b"], ["a", "b"])).toBe(1);
  });
});

describe("pickBestRequirement", () => {
  const linearEq = { id: 1, statement: "Solve linear equations in one variable" };
  const factoring = { id: 2, statement: "Factorise quadratic expressions" };
  const fractions = { id: 3, statement: "Add and subtract fractions with different denominators" };

  it("returns no_candidates when the requirement list is empty", () => {
    const r = pickBestRequirement(
      { misconception: "anything" },
      [],
    );
    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("no_candidates");
  });

  it("picks the requirement with the highest token overlap", () => {
    const r = pickBestRequirement(
      {
        misconception: "Student tries to solve linear equations by guessing the variable",
        studentError: "writes 2x = 7 then x = 7",
        correctApproach: "isolate the variable on one side",
      },
      [linearEq, factoring, fractions],
    );
    expect(r.requirementId).toBe(linearEq.id);
    expect(r.topScore).toBeGreaterThan(0);
  });

  it("returns low_score when nothing crosses the minScore floor", () => {
    const r = pickBestRequirement(
      {
        misconception: "completely unrelated text about cookies and biscuits",
        studentError: "biscuits are not cookies apparently",
        correctApproach: "read the recipe",
      },
      [linearEq, factoring, fractions],
      { minScore: 0.10 },
    );
    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("low_score");
  });

  it("returns ambiguous_tie when two candidates score within minScoreGap of each other", () => {
    // Two requirements that share equally with the misconception.
    const reqA = { id: 10, statement: "fraction operations basic" };
    const reqB = { id: 11, statement: "fraction operations advanced" };
    const r = pickBestRequirement(
      { misconception: "fraction operations confused" },
      [reqA, reqB],
      { minScore: 0.0, minScoreGap: 0.5 },
    );
    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("ambiguous_tie");
    expect(r.topScore).toBeGreaterThan(0);
  });

  it("commits the match when the top exceeds runner-up by minScoreGap", () => {
    const r = pickBestRequirement(
      {
        misconception: "Student factorises quadratic expressions incorrectly",
        studentError: "(x+2)(x+3) for x^2+5x+6 — but writes (x+1)(x+5)",
      },
      [linearEq, factoring, fractions],
      { minScore: 0.05, minScoreGap: 0.02 },
    );
    expect(r.requirementId).toBe(factoring.id);
  });

  it("incorporates notesAndExamples into the candidate text when present", () => {
    const sparse = { id: 100, statement: "trig" };
    const richer = {
      id: 101,
      statement: "applications",
      notesAndExamples: "applying sine and cosine rules to non-right-angled triangles",
    };
    const r = pickBestRequirement(
      {
        misconception: "Student picks the wrong rule for non-right-angled triangles",
        studentError: "uses pythagoras when they should use cosine rule",
        correctApproach: "use the cosine rule when no right angle is given",
      },
      [sparse, richer],
      { minScore: 0.0, minScoreGap: 0.0 },
    );
    expect(r.requirementId).toBe(richer.id);
  });

  it("returns null but reports the actual top score so callers can audit", () => {
    const r = pickBestRequirement(
      { misconception: "completely off-topic gibberish" },
      [linearEq, factoring],
      { minScore: 0.5 },
    );
    expect(r.requirementId).toBeNull();
    expect(typeof r.topScore).toBe("number");
    expect(typeof r.runnerUpScore).toBe("number");
  });
});
