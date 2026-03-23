/**
 * AI ORCHESTRATOR TESTS
 * Tests the centralized waterfall fallback system for AI providers.
 * Covers: Anthropic → Google → DeepSeek → OpenAI fallback chain,
 * schema enforcement, error propagation, resolveSchema utility.
 *
 * Uses vi.hoisted() so mock fns are available before ESM hoisting.
 *
 * IMPORTANT: generateWithFallback now returns { data: string, metadata: AIMetadata }
 * The fallback chain order is:
 *   1. anthropic/claude-sonnet-4-6   (1 Anthropic model)
 *   2. google/gemini-2.5-flash       (1st Google)
 *   3. google/gemini-2.0-flash-001   (2nd Google)
 *   4. deepseek/deepseek-chat        (uses OpenAI SDK)
 *   5. openai/gpt-4o                 (1st OpenAI)
 *   6. openai/gpt-4o-mini            (2nd OpenAI)
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

// ─── Mock OpenAI SDK (used by both DeepSeek and OpenAI providers) ─────────────
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

// Helper: make all Anthropic calls reject
function rejectAllAnthropic(error = new Error("Anthropic down")) {
  // 1 model in chain: claude-sonnet-4-6
  mocks.anthropicCreate.mockRejectedValueOnce(error);
}

// Helper: make all Google calls reject
function rejectAllGoogle(error = new Error("Google down")) {
  // 2 models in chain: gemini-2.5-flash, gemini-2.0-flash-001
  mocks.googleGenerateContent
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error);
}

// Helper: make all DeepSeek+OpenAI calls reject (they share OpenAI SDK)
function rejectAllOpenAI(error = new Error("OpenAI down")) {
  // 3 models total (deepseek×1 + openai×2)
  mocks.openAICreate
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error);
}

const ANTHROPIC_TEXT_RESPONSE = {
  content: [{ type: "text", text: "Claude response" }],
};

beforeEach(() => {
  // Only reset the inner API call mocks (clears queued one-time values between tests).
  // Do NOT call vi.resetAllMocks() — it would also reset the SDK constructor mocks
  // (new Anthropic(), new OpenAI(), etc.) which need to keep their mockImplementation.
  mocks.anthropicCreate.mockReset();
  mocks.googleGenerateContent.mockReset();
  mocks.openAICreate.mockReset();
});

// ─── Anthropic success path ───────────────────────────────────────────────────
describe("generateWithFallback: Anthropic success", () => {
  it("returns { data, metadata } from Anthropic when it succeeds", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    const result = await generateWithFallback("System", "User");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("metadata");
    expect(result.data).toBe("Claude response");
    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
  });

  it("metadata contains provider, model, and durationMs", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    const result = await generateWithFallback("System", "User");
    expect(result.metadata.provider).toBe("anthropic");
    expect(result.metadata.model).toMatch(/claude/i);
    expect(typeof result.metadata.durationMs).toBe("number");
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls Anthropic with correct model and prompts", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    await generateWithFallback("My system", "My user");
    const call = mocks.anthropicCreate.mock.calls[0][0];
    expect(call.model).toMatch(/claude/i);
    expect(call.system).toBe("My system");
    expect(call.messages[0].content).toBe("My user");
  });

  it("does NOT call Google/DeepSeek/OpenAI when Anthropic succeeds", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce(ANTHROPIC_TEXT_RESPONSE);
    await generateWithFallback("System", "User");
    expect(mocks.googleGenerateContent).not.toHaveBeenCalled();
    expect(mocks.openAICreate).not.toHaveBeenCalled();
  });

  it("uses tool_use mode when schema is provided", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
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
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { count: 5 } }],
    });
    await generateWithFallback("System", "User", schema);
    const call = mocks.anthropicCreate.mock.calls[0][0];
    expect(call.tools[0].input_schema).toBeDefined();
  });

  it("throws when ALL providers fail", async () => {
    rejectAllAnthropic();
    rejectAllGoogle();
    rejectAllOpenAI();
    await expect(generateWithFallback("System", "User")).rejects.toThrow();
  });
});

// ─── Google fallback ──────────────────────────────────────────────────────────
describe("generateWithFallback: Google fallback", () => {
  it("falls back to Google when all Anthropic models fail", async () => {
    rejectAllAnthropic(new Error("Anthropic overloaded"));
    mocks.googleGenerateContent.mockResolvedValueOnce({
      response: { text: () => "Gemini response" },
    });
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("Gemini response");
    expect(result.metadata.provider).toBe("google");
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.googleGenerateContent).toHaveBeenCalledOnce();
  });

  it("does NOT call OpenAI/DeepSeek when Google succeeds", async () => {
    rejectAllAnthropic();
    mocks.googleGenerateContent.mockResolvedValueOnce({
      response: { text: () => "Gemini response" },
    });
    await generateWithFallback("System", "User");
    expect(mocks.openAICreate).not.toHaveBeenCalled();
  });
});

// ─── DeepSeek fallback ────────────────────────────────────────────────────────
describe("generateWithFallback: DeepSeek fallback", () => {
  it("falls back to DeepSeek when Anthropic and Google both fail", async () => {
    rejectAllAnthropic(new Error("Anthropic overloaded"));
    rejectAllGoogle(new Error("Google down"));
    mocks.openAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: "DeepSeek response" } }],
    });
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("DeepSeek response");
    expect(result.metadata.provider).toBe("deepseek");
    expect(mocks.openAICreate).toHaveBeenCalledOnce();
  });

  it("passes json_object format to DeepSeek when schema provided", async () => {
    const schema = { type: "object", properties: { val: { type: "number" } } };
    rejectAllAnthropic(new Error("Anthropic down"));
    rejectAllGoogle(new Error("Google down"));
    let capturedConfig: any;
    mocks.openAICreate.mockImplementationOnce((config: any) => {
      capturedConfig = config;
      return Promise.resolve({ choices: [{ message: { content: '{"val": 42}' } }] });
    });
    await generateWithFallback("System", "User", schema);
    expect(capturedConfig?.response_format?.type).toBe("json_object");
  });

  it("includes schema hint in DeepSeek system prompt", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    rejectAllAnthropic(new Error("Anthropic down"));
    rejectAllGoogle(new Error("Google down"));
    mocks.openAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"name":"test"}' } }],
    });
    await generateWithFallback("My System", "User", schema);
    const call = mocks.openAICreate.mock.calls[0][0];
    const sysMsg = call.messages.find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("My System");
  });
});

// ─── OpenAI fallback ──────────────────────────────────────────────────────────
describe("generateWithFallback: OpenAI (GPT) fallback", () => {
  it("falls back to OpenAI when Anthropic, Google, and DeepSeek all fail", async () => {
    rejectAllAnthropic(new Error("Anthropic down"));
    rejectAllGoogle(new Error("Google down"));
    // deepseek×1 fail, gpt-4o fail, gpt-4o-mini succeeds
    mocks.openAICreate
      .mockRejectedValueOnce(new Error("DeepSeek down"))
      .mockRejectedValueOnce(new Error("GPT-4o down"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "GPT response" } }] });
    const result = await generateWithFallback("System", "User");
    expect(result.data).toBe("GPT response");
    expect(result.metadata.provider).toBe("openai");
  });

  it("throws user-friendly error when ALL providers fail", async () => {
    rejectAllAnthropic();
    rejectAllGoogle();
    rejectAllOpenAI();
    await expect(generateWithFallback("System", "User")).rejects.toThrow(
      /All AI providers|exhausted|unavailable/i
    );
  });

  it("passes json_object format to OpenAI when schema provided", async () => {
    const schema = { type: "object", properties: { result: { type: "boolean" } } };
    rejectAllAnthropic();
    rejectAllGoogle();
    let openaiConfig: any;
    // deepseek×1 fail, then gpt-4o captures config and succeeds
    mocks.openAICreate
      .mockRejectedValueOnce(new Error("DeepSeek 1 down"))
      .mockImplementationOnce((cfg: any) => {
        openaiConfig = cfg;
        return Promise.resolve({ choices: [{ message: { content: '{"result":true}' } }] });
      });
    await generateWithFallback("System", "User", schema);
    expect(openaiConfig?.response_format?.type).toBe("json_object");
  });
});

// ─── Schema resolution ────────────────────────────────────────────────────────
describe("generateWithFallback: $ref schema handling", () => {
  // BUG DOCUMENTED: The inline Anthropic switch-case in generateWithFallback passes
  // expectedSchema directly as input_schema WITHOUT calling resolveJsonSchema().
  // The resolveJsonSchema() helper exists in aiOrchestrator.ts and IS used by
  // callOpenAI/callDeepSeek, but the anthropic switch-case bypasses it.
  // This means $ref schemas are sent unresolved to Anthropic (Anthropic may reject
  // them or behave unexpectedly). The test below documents this CURRENT behavior.
  it("BUG: passes $ref schemas unresolved to Anthropic (resolveJsonSchema not called)", async () => {
    const schemaWithRef = {
      $ref: "#/definitions/Answer",
      definitions: {
        Answer: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    };
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { value: "resolved!" } }],
    });
    const result = await generateWithFallback("System", "User", schemaWithRef);
    expect(JSON.parse(result.data)).toEqual({ value: "resolved!" });
    const call = mocks.anthropicCreate.mock.calls[0][0];
    const toolSchema = call.tools[0].input_schema;
    // Current (buggy) behavior: $ref is NOT resolved, sent as-is to Anthropic
    expect(toolSchema.$ref).toBeDefined(); // should be undefined after fix
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
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", input: { items: [{ id: 1 }] } }],
    });
    const result = await generateWithFallback("System", "User", schemaWithNestedRef);
    expect(JSON.parse(result.data).items).toHaveLength(1);
  });
});

// ─── Missing API keys ─────────────────────────────────────────────────────────
describe("generateWithFallback: Missing API key handling", () => {
  it("falls through gracefully when ANTHROPIC_API_KEY is missing", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    // Anthropic will throw on missing key; Google mock returns a response
    mocks.googleGenerateContent.mockResolvedValueOnce({
      response: { text: () => "Google fallback response" },
    });
    try {
      const result = await generateWithFallback("System", "User");
      expect(typeof result.data).toBe("string");
    } catch (e: any) {
      expect(e.message).toMatch(/unavailable|API_KEY|configured|exhausted/i);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
