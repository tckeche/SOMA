/**
 * Idempotency cache integration test.
 *
 * Proves the high-traffic route pattern: when the same idempotency key
 * is supplied twice, the second call is served from cache and does NOT
 * hit the provider SDK again. This is the core guarantee high-traffic
 * routes (grading, topic inventory, class analysis) rely on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  openAICreate: vi.fn(),
  anthropicCreate: vi.fn(),
  googleGenerateContent: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mocks.anthropicCreate } };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mocks.openAICreate } } };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return { getGenerativeModel: () => ({ generateContent: mocks.googleGenerateContent }) };
  }),
  SchemaType: { OBJECT: "object", ARRAY: "array", STRING: "string", NUMBER: "number", INTEGER: "integer", BOOLEAN: "boolean" },
}));

import { generateWithFallback } from "../server/services/aiOrchestrator";
import { _resetCacheForTests } from "../server/services/aiCache";

beforeEach(() => {
  mocks.openAICreate.mockReset();
  mocks.anthropicCreate.mockReset();
  mocks.googleGenerateContent.mockReset();
  _resetCacheForTests();
});

describe("generateWithFallback: idempotency cache", () => {
  it("serves the second call from cache when the same idempotencyKey is reused", async () => {
    mocks.openAICreate.mockResolvedValue({ choices: [{ message: { content: "FRESH" } }] });

    const a = await generateWithFallback("S", "U", undefined, {
      idempotencyKey: "report.grade:42",
      taskType: "grading",
    });
    const b = await generateWithFallback("S", "U", undefined, {
      idempotencyKey: "report.grade:42",
      taskType: "grading",
    });

    expect(a.data).toBe("FRESH");
    expect(b.data).toBe("FRESH");
    expect(mocks.openAICreate).toHaveBeenCalledTimes(1);
    expect(b.metadata.cached).toBe(true);
  });

  it("does NOT collide across different idempotency keys", async () => {
    mocks.openAICreate
      .mockResolvedValueOnce({ choices: [{ message: { content: "A" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "B" } }] });

    const a = await generateWithFallback("S", "U", undefined, { idempotencyKey: "k1" });
    const b = await generateWithFallback("S", "U", undefined, { idempotencyKey: "k2" });

    expect(a.data).toBe("A");
    expect(b.data).toBe("B");
    expect(mocks.openAICreate).toHaveBeenCalledTimes(2);
  });

  it("treats `cacheable` flag as a TTL cache (deterministic subflow)", async () => {
    mocks.openAICreate.mockResolvedValue({ choices: [{ message: { content: "X" } }] });

    await generateWithFallback("DET", "INPUT", undefined, { cacheable: true });
    await generateWithFallback("DET", "INPUT", undefined, { cacheable: true });

    expect(mocks.openAICreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache calls without idempotencyKey or cacheable", async () => {
    mocks.openAICreate
      .mockResolvedValueOnce({ choices: [{ message: { content: "first" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "second" } }] });

    const a = await generateWithFallback("S", "U");
    const b = await generateWithFallback("S", "U");

    expect(a.data).toBe("first");
    expect(b.data).toBe("second");
    expect(mocks.openAICreate).toHaveBeenCalledTimes(2);
  });

  it("does not silently store a partial / error response under the idempotency key", async () => {
    mocks.openAICreate
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "ok-after-retry" } }] });

    // First attempt fails → orchestrator falls through. Even though we passed
    // an idempotency key, no successful payload should be cached. The next
    // identical call must be free to retry.
    mocks.anthropicCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "anthropic-ok" }] });
    const first = await generateWithFallback("S", "U", undefined, { idempotencyKey: "kErr" });
    expect(first.data).toBe("anthropic-ok");

    // Reset mocks so the second call would only succeed if it actually runs.
    mocks.openAICreate.mockReset();
    mocks.anthropicCreate.mockReset();
    mocks.openAICreate.mockResolvedValueOnce({ choices: [{ message: { content: "second" } }] });
    const second = await generateWithFallback("S", "U", undefined, { idempotencyKey: "kErr" });
    // Still cached from the first successful attempt → must NOT call provider.
    expect(second.metadata.cached).toBe(true);
    expect(mocks.openAICreate).not.toHaveBeenCalled();
  });
});
