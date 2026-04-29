/**
 * Tests for cost guardrails (max_tokens caps).
 *
 * Generation tasks must get a HIGH cap so long quizzes (20–30 questions)
 * don't silently truncate. Every other task type must stay tightly capped
 * — verifiers/graders/helpers shouldn't get a 20k allowance just because
 * the maker does.
 */
import { describe, it, expect } from "vitest";
import { clampMaxTokens, maxTokensForTask, maxTokensTable } from "../server/services/aiCostGuards";

describe("aiCostGuards: caps by task type", () => {
  it("generation gets a high cap (>= 20k) for long quiz output", () => {
    expect(maxTokensForTask("generation")).toBeGreaterThanOrEqual(20_000);
  });

  it("verification stays well below the generation cap", () => {
    const v = maxTokensForTask("verification");
    expect(v).toBeLessThanOrEqual(10_000);
    expect(v).toBeLessThan(maxTokensForTask("generation"));
  });

  it("grading stays tightly capped (<= 2k)", () => {
    expect(maxTokensForTask("grading")).toBeLessThanOrEqual(2_048);
  });

  it("chat / extraction / retrieval stay below the generation cap", () => {
    const gen = maxTokensForTask("generation");
    expect(maxTokensForTask("chat")).toBeLessThan(gen);
    expect(maxTokensForTask("extraction")).toBeLessThan(gen);
    expect(maxTokensForTask("retrieval")).toBeLessThan(gen);
  });

  it("returns the default cap for unknown task type", () => {
    expect(maxTokensForTask("totally-unknown")).toBe(4096);
  });

  it("does NOT silently raise every task to the generation cap", () => {
    const table = maxTokensTable();
    const gen = table.generation;
    for (const [task, cap] of Object.entries(table)) {
      if (task === "generation") continue;
      expect(cap, `task=${task} must be below generation cap`).toBeLessThan(gen);
    }
  });
});

describe("aiCostGuards: clampMaxTokens", () => {
  it("clamps requested values that exceed the cap", () => {
    expect(clampMaxTokens(99_999, "grading")).toBeLessThanOrEqual(2_048);
  });

  it("preserves smaller-than-cap requests", () => {
    expect(clampMaxTokens(500, "generation")).toBe(500);
  });

  it("uses the cap when no request value supplied", () => {
    expect(clampMaxTokens(undefined, "verification")).toBe(maxTokensForTask("verification"));
  });

  it("allows generation requests up to ~20k tokens (long quiz support)", () => {
    expect(clampMaxTokens(20_000, "generation")).toBe(20_000);
    expect(clampMaxTokens(16_000, "generation")).toBe(16_000);
  });

  it("does NOT allow grading to claim the generation cap", () => {
    expect(clampMaxTokens(20_000, "grading")).toBeLessThanOrEqual(2_048);
  });
});
