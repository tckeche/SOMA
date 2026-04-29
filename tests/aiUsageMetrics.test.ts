/**
 * Tests for the AI usage / cost aggregator.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { record, report, _resetMetricsForTests } from "../server/services/aiUsageMetrics";

const baseRecord = {
  provider: "openai",
  model: "gpt-4o",
  taskType: "generation",
  promptVersion: "soma.maker:v1",
  route: "quiz.generate",
  userId: "user-1",
  inputTokens: 1000,
  outputTokens: 500,
  costUsd: 0.01,
  latencyMs: 250,
  success: true,
  validationFailed: false,
  parseFailed: false,
  cached: false,
  retryCount: 0,
};

beforeEach(() => {
  _resetMetricsForTests();
});

describe("aiUsageMetrics", () => {
  it("aggregates totals across many calls", () => {
    record(baseRecord);
    record({ ...baseRecord, costUsd: 0.02, inputTokens: 500, outputTokens: 250 });
    const r = report();
    expect(r.overall.calls).toBe(2);
    expect(r.overall.costUsd).toBeCloseTo(0.03, 6);
    expect(r.overall.inputTokens).toBe(1500);
    expect(r.overall.outputTokens).toBe(750);
  });

  it("breaks down by provider/model/route/user", () => {
    record(baseRecord);
    record({ ...baseRecord, provider: "anthropic", model: "claude-sonnet-4-6", costUsd: 0.05 });
    record({ ...baseRecord, route: "quiz.grade", userId: "user-2" });
    const r = report();
    expect(r.byProvider.find((x) => x.key === "openai")?.calls).toBe(2);
    expect(r.byProvider.find((x) => x.key === "anthropic")?.calls).toBe(1);
    expect(r.byRoute.find((x) => x.key === "quiz.generate")).toBeDefined();
    expect(r.byRoute.find((x) => x.key === "quiz.grade")).toBeDefined();
    expect(r.byUser.find((x) => x.key === "user-1")?.calls).toBe(2);
    expect(r.byUser.find((x) => x.key === "user-2")?.calls).toBe(1);
  });

  it("counts validation failures and fallbacks separately", () => {
    record({ ...baseRecord, success: false, validationFailed: true });
    record({ ...baseRecord, retryCount: 2 });
    const r = report();
    expect(r.overall.validationFailures).toBe(1);
    expect(r.overall.fallbacks).toBe(1);
  });

  it("counts cached hits", () => {
    record({ ...baseRecord, cached: true });
    record(baseRecord);
    const r = report();
    expect(r.overall.cachedHits).toBe(1);
  });

  it("reports p95 latency per dimension", () => {
    for (let i = 0; i < 100; i++) record({ ...baseRecord, latencyMs: i });
    const r = report();
    expect(r.overall.p95LatencyMs).toBeGreaterThanOrEqual(94);
  });

  it("sorts dimension breakdowns by cost descending", () => {
    record({ ...baseRecord, route: "cheap", costUsd: 0.01 });
    record({ ...baseRecord, route: "expensive", costUsd: 1.0 });
    const r = report();
    expect(r.byRoute[0].key).toBe("expensive");
  });
});
