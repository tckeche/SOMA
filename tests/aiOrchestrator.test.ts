/**
 * AI ORCHESTRATOR TESTS
 * Tests the centralized waterfall fallback system for AI providers.
 * Covers: OpenAI (GPT-4o) → Anthropic → Google → o3-mini → DeepSeek → GPT-4o-mini fallback chain,
 * schema enforcement, error propagation, resolveSchema utility.
 *
 * Uses vi.hoisted() so mock fns are available before ESM hoisting.
 *
 * IMPORTANT: generateWithFallback now returns { data: string, metadata: AIMetadata }
 * The fallback chain order is:
 *   1. openai/gpt-4o            (primary)
 *   2. anthropic/claude-sonnet-4-6
 *   3. google/gemini-2.5-flash
 *   4. openai/o3-mini
 *   5. deepseek/deepseek-chat   (uses OpenAI SDK)
 *   6. openai/gpt-4o-mini
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── vi.hoisted: define mock functions BEFORE module hoisting ─────────────────
const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openAICreate: vi.fn(),
  googleGenerateContent: vi.fn(),
}));

// ─── Mock Anthropic SDK ──────────────────────────────────────────────────────
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mocks.anthropicCreate } };
  }),
}));

// ─── Mock OpenAI SDK (used by GPT-4o, o3-mini, DeepSeek, GPT-4o-mini) ───────
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mocks.openAICreate } } };
  }),
}));

// ─── Mock Google Generative AI SDK ────────────────────────────────────────────
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: () => ({
        generateContent: mocks.googleGenerateContent,
      }),
    };
  }),
  SchemaType: {
    OBJECT: "object",
    ARRAY: "array",
    STRING: "string",
    NUMBER: "number",
    INTEGER: "integer",
    BOOLEAN: "boolean",
  },
}));

import { generateWithFallback } from "../server/services/aiOrchestrator";

// Helper: make the first OpenAI call (gpt-4o) reject
function rejectGpt4o(error = new Error("GPT-4o down")) {
  mocks.openAICreate.mockRejectedValueOnce(error);
}

// Helper: make all Anthropic calls reject
function rejectAllAnthropic(error = new Error("Anthropic down")) {
  mocks.anthropicCreate.mockRejectedValueOnce(error);
}

// Helper: make all Google calls reject
function rejectAllGoogle(error = new Error("Google down")) {
  mocks.googleGenerateContent.mockRejectedValueOnce(error);
}

// Helper: reject everything (gpt-4o×1, anthropic×1, google×1, o3-mini×1, deepseek×1, gpt-4o-mini×1)
function rejectAll() {
  mocks.openAICreate
    .mockRejectedValueOnce(new Error("GPT-4o down"))
    .mockRejectedValueOnce(new Error("o3-mini down"))
    .mockRejectedValueOnce(new Error("DeepSeek down"))
    .mockRejectedValueOnce(new Error("GPT-4o-mini down"));
  mocks.anthropicCreate.mockRejectedValueOnce(new Error("Anthropic down"));
  mocks.googleGenerateContent.mockRejectedValueOnce(new Error("Google down"));
}

const OPENAI_TEXT_RESPONSE = {
  choices: [{ message: { content: "GPT-4o response" } }],
};

const ANTHROPIC_TEXT_RESPONSE = {
  content: [{ type: "text", text: "Claude response" }],
};

beforeEach(() => {
  mocks.anthropicCreate.mockReset();
  mocks.googleGenerateContent.mockReset();
  mocks.openAICreate.mockReset();
});

// ─── GPT-4o success path (primary) ───────────────────────────────────────────
describe("generateWithFallback: GPT-4o success (primary)", () => {
  it("returns { data, metadata } from GPT-4o when it succeeds", async () => {
    mocks.openAICreate.mockResolvedValueOnce(OPENAI_TEXT_RESPONSE);
    const result = await generateWithFallback("System", "User");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("metadata");
    expect(result.data).toBe("GPT-4o response");
    expect(mocks.openAICreate).toHaveBeenCalledOnce();
  });

  it("metadata contains provider, model, and durationMs", async () => {
    mocks.openAICreate.mockResolvedValueOnce(OPENAI_TEXT_RESPONSE);
    const result = await generateWithFallback("System", "User");
    expect(result.metadata.provider).toBe("openai");
    expect(result.metadata.model).toMatch(/gpt-4o/i);
    expect(typeof result.metadata.durationMs).toBe("number");
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does NOT call Anthropic/Google when GPT-4o succeeds", async () => {
    mocks.openAICreate.mockResolvedValueOnce(OPENAI_TEXT_RESPONSE);
    await generateWithFallback("System", "User");
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.googleGenerateContent).not.toHaveBeenCalled();
  });

  it("passes json_object format to GPT-4o when schema provided", async () => {
    const schema = { type: "object", properties: { result: { type: "boolean" } } };
    let capturedConfig: any;
    mocks.openAICreate.mockImplementationOnce((cfg: any) => {
      capturedConfig = cfg;
      return Promise.resolve({ choices: [{ message: { content: '{"result":true}' } }] });
    });
    await generateWithFallback("System", "User", schema);
    expect(capturedConfig?.response_format?.type).toBe("json_object");
  });

  it("throws when ALL providers fail", async () => {
    rejectAll();
    await expect(generateWithFallback("System", "User")).rejects.toThrow();
  });
});

// ─── Anthropic fallback ──────────────────────────────────────────────────────
describe("generateWithFallback: Anthropic fallback", () => {
  it("falls back to Anthropic when GPT-4o fails", async () => {
    rejectGpt4o(new Error("GPT-4o overloaded"));
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("Claude response");
    expect(result.metadata.provider).toBe("anthropic");
    expect(mocks.openAICreate).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
  });

  it("does NOT call Google when Anthropic succeeds", async () => {
    rejectGpt4o();
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    await generateWithFallback("System", "User");
    expect(mocks.googleGenerateContent).not.toHaveBeenCalled();
  });

  it("uses tool_use mode when schema is provided", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    rejectGpt4o();
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { answer: "42" } }],
    });
    const result = await generateWithFallback("System", "User", schema);
    expect(JSON.parse(result.data)).toEqual({ answer: "42" });
    const call = mocks.anthropicCreate.mock.calls[0][0];
    expect(call.tool_choice).toBeDefined();
    expect(call.tools).toBeDefined();
    expect(call.tools.length).toBeGreaterThan(0);
  });

  it("sends schema as tool input_schema to Anthropic", async () => {
    const schema = { type: "object", properties: { count: { type: "integer" } } };
    rejectGpt4o();
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { count: 5 } }],
    });
    await generateWithFallback("System", "User", schema);
    const call = mocks.anthropicCreate.mock.calls[0][0];
    expect(call.tools[0].input_schema).toBeDefined();
  });
});

// ─── Google fallback ─────────────────────────────────────────────────────────
describe("generateWithFallback: Google fallback", () => {
  it("falls back to Google when GPT-4o and Anthropic both fail", async () => {
    rejectGpt4o(new Error("GPT-4o overloaded"));
    rejectAllAnthropic(new Error("Anthropic overloaded"));
    mocks.googleGenerateContent.mockResolvedValueOnce({
      response: { text: () => "Gemini response" },
    });
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("Gemini response");
    expect(result.metadata.provider).toBe("google");
    expect(mocks.openAICreate).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    expect(mocks.googleGenerateContent).toHaveBeenCalledOnce();
  });
});

// ─── DeepSeek fallback ───────────────────────────────────────────────────────
describe("generateWithFallback: DeepSeek fallback", () => {
  it("falls back to DeepSeek when GPT-4o, Anthropic, Google, and o3-mini all fail", async () => {
    rejectGpt4o(new Error("GPT-4o down"));
    rejectAllAnthropic(new Error("Anthropic down"));
    rejectAllGoogle(new Error("Google down"));
    mocks.openAICreate
      .mockRejectedValueOnce(new Error("o3-mini down"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "DeepSeek response" } }] });
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("DeepSeek response");
    expect(result.metadata.provider).toBe("deepseek");
  });

  it("passes json_object format to DeepSeek when schema provided", async () => {
    const schema = { type: "object", properties: { val: { type: "number" } } };
    rejectGpt4o(new Error("GPT-4o down"));
    rejectAllAnthropic(new Error("Anthropic down"));
    rejectAllGoogle(new Error("Google down"));
    let capturedConfig: any;
    mocks.openAICreate
      .mockRejectedValueOnce(new Error("o3-mini down"))
      .mockImplementationOnce((config: any) => {
        capturedConfig = config;
        return Promise.resolve({ choices: [{ message: { content: '{"val": 42}' } }] });
      });
    await generateWithFallback("System", "User", schema);
    expect(capturedConfig?.response_format?.type).toBe("json_object");
  });
});

// ─── GPT-4o-mini fallback (last resort) ──────────────────────────────────────
describe("generateWithFallback: GPT-4o-mini fallback (last resort)", () => {
  it("falls back to GPT-4o-mini when all others fail", async () => {
    rejectGpt4o(new Error("GPT-4o down"));
    rejectAllAnthropic(new Error("Anthropic down"));
    rejectAllGoogle(new Error("Google down"));
    mocks.openAICreate
      .mockRejectedValueOnce(new Error("o3-mini down"))
      .mockRejectedValueOnce(new Error("DeepSeek down"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "GPT-4o-mini response" } }] });
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("GPT-4o-mini response");
    expect(result.metadata.provider).toBe("openai");
  });

  it("throws user-friendly error when ALL providers fail", async () => {
    rejectAll();
    await expect(generateWithFallback("System", "User")).rejects.toThrow(
      /All AI providers|exhausted|unavailable/i
    );
  });
});

// ─── Schema resolution ────────────────────────────────────────────────────────
describe("generateWithFallback: $ref schema handling", () => {
  it("handles $ref schemas via Anthropic fallback", async () => {
    const schemaWithRef = {
      $ref: "#/definitions/Answer",
      definitions: {
        Answer: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    };
    rejectGpt4o();
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { value: "resolved!" } }],
    });
    const result = await generateWithFallback("System", "User", schemaWithRef);
    expect(JSON.parse(result.data)).toEqual({ value: "resolved!" });
  });

  it("handles nested $ref — Anthropic receives tool_use input correctly", async () => {
    const schemaWithNestedRef = {
      $ref: "#/definitions/Container",
      definitions: {
        Item: { type: "object", properties: { id: { type: "number" } } },
        Container: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: "#/definitions/Item" } },
          },
        },
      },
    };
    rejectGpt4o();
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { items: [{ id: 1 }] } }],
    });
    const result = await generateWithFallback("System", "User", schemaWithNestedRef);
    expect(JSON.parse(result.data).items).toHaveLength(1);
  });
});

// ─── Missing API keys ─────────────────────────────────────────────────────────
describe("generateWithFallback: Missing API key handling", () => {
  it("falls through gracefully when OPENAI_API_KEY is missing", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    try {
      const result = await generateWithFallback("System", "User");
      expect(typeof result.data).toBe("string");
    } catch (e: any) {
      expect(e.message).toMatch(/unavailable|API_KEY|configured|exhausted/i);
    } finally {
      process.env.OPENAI_API_KEY = saved;
    }
  });
});
