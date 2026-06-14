/**
 * Tests for the SOMA blueprint planner (Stage 0 of the generation pipeline).
 *
 * The planner is intentionally split into pure helpers (allocation,
 * difficulty distribution, anchor flattening, post-LLM enforcement) plus the
 * thin LLM wrapper. We test the helpers directly because they carry the
 * pedagogical correctness that makes the maker's output traceable.
 */
import { describe, it, expect } from "vitest";

import {
  allocateRolesByPurpose,
  distributeDifficulty,
  enforceAllocation,
  flattenCatalogueAnchors,
  inferPurposeFromPrompt,
  renderBlueprintForMaker,
  type Blueprint,
  type BlueprintInput,
} from "../server/services/aiBlueprint";
import type { CatalogueCopilotContext } from "../server/services/copilotContext";
import type { ExaminerSeed } from "../server/services/examinerDistractorSeeds";

// ─── Allocation rules ──────────────────────────────────────────────────────

describe("allocateRolesByPurpose", () => {
  it("uses 65/35 coverage/probe for the general purpose when seeds exist", () => {
    expect(allocateRolesByPurpose(10, "general", true)).toEqual({ coverage: 6, probe: 4 });
  });

  it("flips the ratio toward probes for struggling_areas (35/65)", () => {
    expect(allocateRolesByPurpose(10, "struggling_areas", true)).toEqual({ coverage: 3, probe: 7 });
  });

  it("emphasises coverage for stretch_strengths (80/20)", () => {
    expect(allocateRolesByPurpose(10, "stretch_strengths", true)).toEqual({ coverage: 8, probe: 2 });
  });

  it("falls back to coverage-only when there are no seeds, regardless of purpose", () => {
    for (const purpose of ["general", "struggling_areas", "stretch_strengths", "revision"] as const) {
      expect(allocateRolesByPurpose(8, purpose, false)).toEqual({ coverage: 8, probe: 0 });
    }
  });

  it("guarantees at least 1 probe row on small batches when seeds exist", () => {
    // 4 questions × 0.3 = 1.2 → ceil to 2 probe rows under general
    expect(allocateRolesByPurpose(4, "general", true).probe).toBeGreaterThanOrEqual(1);
    // even on a single-question batch with seeds, we still try one probe
    expect(allocateRolesByPurpose(1, "struggling_areas", true)).toEqual({ coverage: 0, probe: 1 });
  });

  it("returns zeros for non-positive question counts", () => {
    expect(allocateRolesByPurpose(0, "general", true)).toEqual({ coverage: 0, probe: 0 });
  });
});

// ─── Difficulty distribution ────────────────────────────────────────────────

describe("distributeDifficulty", () => {
  it("distributes 25/50/25 over 8 questions as 2/4/2", () => {
    expect(distributeDifficulty(8, { easy: 25, medium: 50, hard: 25 })).toEqual({
      easy: 2, medium: 4, hard: 2,
    });
  });

  it("always sums to questionCount even with rounding noise", () => {
    const totals = [3, 5, 7, 11, 13];
    for (const n of totals) {
      const d = distributeDifficulty(n, { easy: 25, medium: 50, hard: 25 });
      expect(d.easy + d.medium + d.hard).toBe(n);
    }
  });

  it("normalises percentages that don't sum to 100", () => {
    const d = distributeDifficulty(10, { easy: 1, medium: 2, hard: 1 });
    expect(d.easy + d.medium + d.hard).toBe(10);
  });
});

// ─── Catalogue anchor flattening ────────────────────────────────────────────

describe("flattenCatalogueAnchors", () => {
  it("returns [] when there is no catalogue context", () => {
    expect(flattenCatalogueAnchors(undefined)).toEqual([]);
  });

  it("emits one anchor per (subtopic × learning requirement) pair", () => {
    const ctx: CatalogueCopilotContext = {
      examiningBody: { id: 1, slug: "cambridge", displayName: "Cambridge" },
      level: { id: 1, code: "IGCSE", displayName: "IGCSE" },
      subject: { id: 1, slug: "math", name: "Mathematics" },
      syllabusCode: "0580",
      syllabusTitle: "Math 0580",
      timeLimitMinutes: null,
      selectedTopics: [
        {
          topic: { id: 11, topicNumber: "1.1", title: "Number" },
          subtopics: [
            { subtopicNumber: "1.1.1", title: "Integers", levelTier: "IGCSE", coreOrExtended: "Core" },
            { subtopicNumber: "1.1.2", title: "Fractions", levelTier: "IGCSE", coreOrExtended: "Core" },
          ],
          learningRequirements: [
            { statement: "State the definition of a prime number", commandWord: "State", notesAndExamples: null },
            { statement: "Identify factors and multiples", commandWord: "Identify", notesAndExamples: null },
          ],
          competencies: [],
          papers: [],
        },
      ],
      subjectDigest: null,
    };
    const anchors = flattenCatalogueAnchors(ctx);
    // 2 subtopics × 2 requirements = 4 anchors
    expect(anchors).toHaveLength(4);
    expect(anchors[0]).toEqual({
      subtopicLabel: "1.1.1 Integers",
      learningRequirement: "State the definition of a prime number",
      commandWord: "State",
    });
  });
});

// ─── Purpose inference ──────────────────────────────────────────────────────

describe("inferPurposeFromPrompt", () => {
  it("detects explicit Purpose: tags", () => {
    expect(inferPurposeFromPrompt("Purpose: struggling_areas. Rationale: ...")).toBe("struggling_areas");
    expect(inferPurposeFromPrompt("purpose=stretch_strengths and ...")).toBe("stretch_strengths");
    expect(inferPurposeFromPrompt("Purpose: revision.")).toBe("revision");
  });

  it("falls back to general for unknown or missing purposes", () => {
    expect(inferPurposeFromPrompt(undefined)).toBe("general");
    expect(inferPurposeFromPrompt("")).toBe("general");
    expect(inferPurposeFromPrompt("Purpose: something_else")).toBe("general");
    expect(inferPurposeFromPrompt("just a free-text prompt")).toBe("general");
  });
});

// ─── Post-LLM enforcement (the safety net) ──────────────────────────────────

const seed = (id: number, freq: ExaminerSeed["frequency"] = "common"): ExaminerSeed => ({
  id,
  topic: "Algebra",
  subtopic: null,
  misconception: `Misconception ${id}`,
  studentError: `Wrong working ${id}`,
  correctApproach: `Right working ${id}`,
  frequency: freq,
  sourceQuote: null,
  sourcePage: null,
});

const baseInput = (overrides: Partial<BlueprintInput> = {}): BlueprintInput => ({
  questionCount: 4,
  purpose: "general",
  difficultyDistribution: { easy: 25, medium: 50, hard: 25 },
  examinerSeeds: [seed(1), seed(2), seed(3)],
  topic: "Algebra",
  subject: "Mathematics",
  syllabus: "Cambridge",
  level: "IGCSE",
  ...overrides,
});

describe("enforceAllocation", () => {
  it("strips invalid misconception ids on probe rows and demotes them to coverage", () => {
    const input = baseInput();
    const blueprint: Blueprint = {
      rows: [
        { questionIndex: 1, role: "misconception_probe", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: 999, difficulty: "easy", intent: "probe a fake id" },
        { questionIndex: 2, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium", intent: "cover" },
        { questionIndex: 3, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium", intent: "cover" },
        { questionIndex: 4, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "hard", intent: "cover" },
      ],
    };
    const result = enforceAllocation(blueprint, input, { coverage: 3, probe: 1 }, { easy: 1, medium: 2, hard: 1 });
    // Row 1 had a fake id → demoted to coverage. We then need 1 probe; the
    // next coverage row gets promoted using an unused seed.
    const probes = result.rows.filter((r) => r.role === "misconception_probe");
    expect(probes).toHaveLength(1);
    expect(probes[0].targetMisconceptionId).toBeOneOf([1, 2, 3]);
  });

  it("clears stray targetMisconceptionId on coverage rows", () => {
    const input = baseInput({ examinerSeeds: [] });
    const blueprint: Blueprint = {
      rows: [
        { questionIndex: 1, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: 1, difficulty: "easy", intent: "x" },
        { questionIndex: 2, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium", intent: "x" },
        { questionIndex: 3, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium", intent: "x" },
        { questionIndex: 4, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "hard", intent: "x" },
      ],
    };
    const result = enforceAllocation(blueprint, input, { coverage: 4, probe: 0 }, { easy: 1, medium: 2, hard: 1 });
    expect(result.rows.every((r) => r.targetMisconceptionId === null)).toBe(true);
  });

  it("pads short blueprints up to questionCount", () => {
    const input = baseInput({ questionCount: 5 });
    const blueprint: Blueprint = {
      rows: [
        { questionIndex: 1, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "easy", intent: "x" },
        { questionIndex: 2, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium", intent: "x" },
      ],
    };
    const result = enforceAllocation(blueprint, input, { coverage: 5, probe: 0 }, { easy: 2, medium: 2, hard: 1 });
    expect(result.rows).toHaveLength(5);
    expect(result.rows.map((r) => r.questionIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it("trims long blueprints back down to questionCount", () => {
    const input = baseInput({ questionCount: 2 });
    const blueprint: Blueprint = {
      rows: Array.from({ length: 5 }, (_, i) => ({
        questionIndex: i + 1, role: "syllabus_coverage" as const, subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "easy" as const, intent: "x",
      })),
    };
    const result = enforceAllocation(blueprint, input, { coverage: 2, probe: 0 }, { easy: 1, medium: 1, hard: 0 });
    expect(result.rows).toHaveLength(2);
  });

  it("reassigns difficulty so counts exactly match distributeDifficulty (n=4, 25/50/25)", () => {
    const input = baseInput({ questionCount: 4, examinerSeeds: [] });
    const target = { easy: 25, medium: 50, hard: 25 };
    const counts = distributeDifficulty(4, target); // caller passes COUNTS
    const blueprint: Blueprint = {
      rows: Array.from({ length: 4 }, (_, i) => ({
        questionIndex: i + 1, role: "syllabus_coverage" as const, subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "hard" as const, intent: "x",
      })),
    };
    const result = enforceAllocation(blueprint, input, { coverage: 4, probe: 0 }, counts);
    const tally = { easy: 0, medium: 0, hard: 0 };
    for (const r of result.rows) tally[r.difficulty] += 1;
    expect(tally).toEqual(distributeDifficulty(result.rows.length, target));
  });

  it("reassigns difficulty exactly even when rounding matters (n=7, 25/50/25)", () => {
    const input = baseInput({ questionCount: 7, examinerSeeds: [] });
    const target = { easy: 25, medium: 50, hard: 25 };
    const counts = distributeDifficulty(7, target);
    const blueprint: Blueprint = {
      rows: Array.from({ length: 7 }, (_, i) => ({
        questionIndex: i + 1, role: "syllabus_coverage" as const, subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "easy" as const, intent: "x",
      })),
    };
    const result = enforceAllocation(blueprint, input, { coverage: 7, probe: 0 }, counts);
    const tally = { easy: 0, medium: 0, hard: 0 };
    for (const r of result.rows) tally[r.difficulty] += 1;
    expect(tally.easy + tally.medium + tally.hard).toBe(7);
    expect(tally).toEqual(distributeDifficulty(7, target));
  });

  it("enforces the exact difficulty split even when the planner returned a different mix", () => {
    const input = baseInput({ questionCount: 6, examinerSeeds: [] });
    const target = { easy: 50, medium: 0, hard: 50 };
    const counts = distributeDifficulty(6, target);
    const blueprint: Blueprint = {
      rows: Array.from({ length: 6 }, (_, i) => ({
        questionIndex: i + 1, role: "syllabus_coverage" as const, subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium" as const, intent: "x",
      })),
    };
    const result = enforceAllocation(blueprint, input, { coverage: 6, probe: 0 }, counts);
    const tally = { easy: 0, medium: 0, hard: 0 };
    for (const r of result.rows) tally[r.difficulty] += 1;
    expect(tally).toEqual({ easy: 3, medium: 0, hard: 3 });
  });

  it("re-numbers questionIndex sequentially after editing", () => {
    const input = baseInput({ questionCount: 3 });
    const blueprint: Blueprint = {
      rows: [
        { questionIndex: 7, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "easy", intent: "x" },
        { questionIndex: 9, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "medium", intent: "x" },
        { questionIndex: 11, role: "syllabus_coverage", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: null, difficulty: "hard", intent: "x" },
      ],
    };
    const result = enforceAllocation(blueprint, input, { coverage: 3, probe: 0 }, { easy: 1, medium: 1, hard: 1 });
    expect(result.rows.map((r) => r.questionIndex)).toEqual([1, 2, 3]);
  });
});

// ─── Maker prompt rendering ────────────────────────────────────────────────

describe("renderBlueprintForMaker", () => {
  it("emits a labelled grid with PROBE rows citing the seed text and a distractor rule", () => {
    const seeds: ExaminerSeed[] = [seed(42, "very_common")];
    const blueprint: Blueprint = {
      rows: [
        { questionIndex: 1, role: "syllabus_coverage", subtopicLabel: "1.1.1 Integers", learningRequirement: "Identify factors", commandWord: "Identify", targetMisconceptionId: null, difficulty: "easy", intent: "Cover identification of factors" },
        { questionIndex: 2, role: "misconception_probe", subtopicLabel: "1.1.1 Integers", learningRequirement: "Identify factors", commandWord: "Identify", targetMisconceptionId: 42, difficulty: "medium", intent: "Probe seed 42" },
      ],
    };
    const text = renderBlueprintForMaker(blueprint, seeds);
    expect(text).toContain("Q1 [easy] COVERAGE");
    expect(text).toContain("Q2 [medium] PROBE misconception #42");
    expect(text).toContain("Misconception 42");
    expect(text).toContain("Wrong working 42");
    expect(text).toContain("at least one distractor MUST embody this misconception");
    expect(text).toContain("Pairing rule: produce exactly one question per row");
  });

  it("falls back gracefully when a probe row's seed is missing from the seed list", () => {
    const blueprint: Blueprint = {
      rows: [
        { questionIndex: 1, role: "misconception_probe", subtopicLabel: "", learningRequirement: "", commandWord: null, targetMisconceptionId: 99, difficulty: "easy", intent: "probe" },
      ],
    };
    const text = renderBlueprintForMaker(blueprint, []);
    expect(text).toContain("(seed text unavailable)");
  });
});
