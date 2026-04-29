/**
 * Tests for the AI telemetry envelope.
 */
import { describe, it, expect, vi } from "vitest";
import {
  approxTokens,
  hashPayload,
  estimateCostUsd,
  recordCall,
  newRequestId,
} from "../server/utils/aiTelemetry";

describe("aiTelemetry: hashPayload", () => {
  it("returns a 32-char deterministic hash", () => {
    const a = hashPayload("system", " ", "user");
    const b = hashPayload("system", " ", "user");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("differs for different inputs", () => {
    expect(hashPayload("a")).not.toBe(hashPayload("b"));
  });
});

describe("aiTelemetry: approxTokens", () => {
  it("returns 0 for empty input", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens(null)).toBe(0);
    expect(approxTokens(undefined)).toBe(0);
  });

  it("approximates ~4 chars per token", () => {
    expect(approxTokens("abcdefgh")).toBe(2); // 8 chars / 4
  });
});

describe("aiTelemetry: estimateCostUsd", () => {
  it("returns null for unknown model", () => {
    expect(estimateCostUsd("foo", "bar", 1000, 1000)).toBeNull();
  });

  it("returns a positive cost for known model", () => {
    const cost = estimateCostUsd("openai", "gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBeGreaterThan(0);
  });
});

describe("aiTelemetry: recordCall", () => {
  it("emits a single AI_TELEMETRY log line and returns the envelope", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = recordCall({
      provider: "openai",
      model: "gpt-4o",
      systemPrompt: "S",
      userPrompt: "U",
      startedAt: 1000,
      endedAt: 1500,
      rawResponse: "ok",
    });
    expect(env.provider).toBe("openai");
    expect(env.latency_ms).toBe(500);
    expect(env.prompt_hash).toHaveLength(32);
    const calls = spy.mock.calls.flat().filter((m) => typeof m === "string" && m.startsWith("[AI_TELEMETRY]"));
    expect(calls.length).toBeGreaterThan(0);
  });

  it("never throws — failures must not poison the call path", () => {
    const id = newRequestId();
    expect(() =>
      recordCall({
        requestId: id,
        provider: "x",
        model: "y",
        systemPrompt: "",
        userPrompt: "",
        startedAt: 0,
        endedAt: 1,
      }),
    ).not.toThrow();
  });
});
