/**
 * Tests for cost guardrails (max_tokens caps).
 */
import { describe, it, expect } from "vitest";
import { clampMaxTokens, maxTokensForTask } from "../server/services/aiCostGuards";

describe("aiCostGuards", () => {
  it("returns the default cap for unknown task type", () => {
    expect(maxTokensForTask("totally-unknown")).toBe(4096);
  });

  it("clamps requested values that exceed the cap", () => {
    expect(clampMaxTokens(99_999, "grading")).toBe(1024);
  });

  it("preserves smaller-than-cap requests", () => {
    expect(clampMaxTokens(500, "generation")).toBe(500);
  });

  it("uses the cap when no request value supplied", () => {
    expect(clampMaxTokens(undefined, "verification")).toBe(8192);
  });
});
