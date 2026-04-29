/**
 * Tests for circuit-breaker / health-aware routing.
 *
 * We force the breaker on (it is disabled by default in NODE_ENV=test) so the
 * routing logic actually trips during these assertions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as health from "../server/services/aiHealth";

const CHAIN = [
  { provider: "openai", model: "gpt-4o" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "google", model: "gemini-2.5-flash" },
];

beforeEach(() => {
  health._resetHealthForTests();
  process.env.AI_CIRCUIT_BREAKER = "1";
});

describe("aiHealth: success / failure tracking", () => {
  it("records successes without tripping the breaker", () => {
    health.recordSuccess("openai", "gpt-4o", 100);
    expect(health.isInCooldown("openai", "gpt-4o")).toBe(false);
  });

  it("records failures and trips cooldown after threshold", () => {
    for (let i = 0; i < 6; i++) {
      health.recordFailure("openai", "gpt-4o", "other");
    }
    expect(health.isInCooldown("openai", "gpt-4o")).toBe(true);
  });

  it("does NOT trip with mixed traffic below failure rate", () => {
    for (let i = 0; i < 10; i++) health.recordSuccess("openai", "gpt-4o", 100);
    for (let i = 0; i < 4; i++) health.recordFailure("openai", "gpt-4o", "other");
    expect(health.isInCooldown("openai", "gpt-4o")).toBe(false);
  });
});

describe("aiHealth: pluggable storage backend", () => {
  it("uses in-memory backend by default", () => {
    expect(health.currentHealthBackend()).toBe("memory");
  });

  it("snapshot returns rich per-provider metrics", () => {
    health.recordSuccess("openai", "gpt-4o", 100);
    health.recordSuccess("openai", "gpt-4o", 200);
    health.recordFailure("openai", "gpt-4o", "timeout");
    health.recordFailure("openai", "gpt-4o", "validation");
    const snap = health.snapshot();
    const row = snap.find((r) => r.provider === "openai");
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.successes).toBe(2);
    expect(row.failures).toBe(2);
    expect(row.timeouts).toBe(1);
    expect(row.validationFailures).toBe(1);
    expect(row.successRate).toBeCloseTo(0.5, 5);
    expect(row.p95LatencyMs).toBeGreaterThan(0);
  });

  it("setHealthStore swaps to a custom backend", () => {
    const backing = new Map<string, any>();
    const fakeStore: health.HealthStore = {
      backend: "fake",
      read: (k) => backing.get(k) ?? null,
      write: (k, v) => { backing.set(k, v); },
      keys: () => Array.from(backing.keys()),
      clear: () => { backing.clear(); },
    };
    health.setHealthStore(fakeStore);
    expect(health.currentHealthBackend()).toBe("fake");
    health.recordSuccess("openai", "gpt-4o", 50);
    expect(backing.size).toBeGreaterThan(0);
    health._useMemoryStoreForTests();
  });
});

describe("aiHealth: reorderByHealth", () => {
  it("preserves original order when no failures recorded", () => {
    const ordered = health.reorderByHealth(CHAIN);
    expect(ordered.map((c) => c.provider)).toEqual(["openai", "anthropic", "google"]);
  });

  it("pushes cooled-down providers to the back", () => {
    for (let i = 0; i < 6; i++) health.recordFailure("openai", "gpt-4o", "other");
    const ordered = health.reorderByHealth(CHAIN);
    expect(ordered[ordered.length - 1].provider).toBe("openai");
  });

  it("returns input unchanged when breaker disabled", () => {
    process.env.AI_CIRCUIT_BREAKER = "0";
    for (let i = 0; i < 6; i++) health.recordFailure("openai", "gpt-4o", "other");
    const ordered = health.reorderByHealth(CHAIN);
    expect(ordered).toEqual(CHAIN);
  });
});
