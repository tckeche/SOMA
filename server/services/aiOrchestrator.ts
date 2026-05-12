import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  newRequestId,
  hashPayload,
  recordCall,
  approxTokens,
} from "../utils/aiTelemetry";
import * as health from "./aiHealth";
import * as cache from "./aiCache";
import { clampMaxTokens } from "./aiCostGuards";

interface ModelConfig {
  provider: "google" | "openai" | "anthropic" | "deepseek";
  model: string;
}

const AI_FALLBACK_CHAIN: ModelConfig[] = [
  // --- TIER 1: OPENAI (PRIMARY) ---
  { provider: "openai", model: "gpt-4o" },

  // --- TIER 2: ANTHROPIC ---
  { provider: "anthropic", model: "claude-sonnet-4-6" },

  // --- TIER 3: GOOGLE GEMINI ---
  { provider: "google", model: "gemini-2.5-flash" },

  // --- TIER 4: REMAINING FALLBACKS ---
  { provider: "openai", model: "o3-mini" },
  { provider: "deepseek", model: "deepseek-chat" },
  { provider: "openai", model: "gpt-4o-mini" },
];

function convertToGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return undefined;

  const convert = (node: any, defs?: any): any => {
    if (!node || typeof node !== "object") return node;
    const definitions = defs || node.definitions;

    if (node.$ref) {
      const refName = node.$ref.replace("#/definitions/", "");
      if (definitions?.[refName]) {
        return convert(definitions[refName], definitions);
      }
    }

    const result: any = {};

    if (node.type === "object") {
      result.type = SchemaType.OBJECT;
      if (node.properties) {
        result.properties = {};
        for (const [key, val] of Object.entries(node.properties) as any) {
          result.properties[key] = convert(val, definitions);
        }
      }
      if (node.required) result.required = node.required;
    } else if (node.type === "array") {
      result.type = SchemaType.ARRAY;
      if (node.items) {
        result.items = convert(node.items, definitions);
      }
    } else if (node.type === "string") {
      result.type = SchemaType.STRING;
    } else if (node.type === "number") {
      result.type = SchemaType.NUMBER;
    } else if (node.type === "integer") {
      result.type = SchemaType.INTEGER;
    } else if (node.type === "boolean") {
      result.type = SchemaType.BOOLEAN;
    } else {
      return node;
    }

    return result;
  };

  let root = schema;
  if (schema.$ref && schema.definitions) {
    const refName = schema.$ref.replace("#/definitions/", "");
    root = { ...schema.definitions[refName], definitions: schema.definitions };
  }

  return convert(root, schema.definitions);
}

function resolveJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref && schema.definitions) {
    const refName = schema.$ref.replace("#/definitions/", "");
    if (schema.definitions[refName]) {
      const resolved = JSON.parse(JSON.stringify(schema.definitions[refName]));
      const resolveRefs = (node: any): any => {
        if (!node || typeof node !== "object") return node;
        if (node.$ref) {
          const innerRef = node.$ref.replace("#/definitions/", "");
          if (schema.definitions[innerRef]) {
            return resolveRefs(JSON.parse(JSON.stringify(schema.definitions[innerRef])));
          }
        }
        if (node.properties) {
          for (const key of Object.keys(node.properties)) {
            node.properties[key] = resolveRefs(node.properties[key]);
          }
        }
        if (node.items) {
          node.items = resolveRefs(node.items);
        }
        return node;
      };
      return resolveRefs(resolved);
    }
  }
  return schema;
}

export async function callGoogle(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  expectedSchema?: any
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const genAI = new GoogleGenerativeAI(apiKey);

  const generationConfig: any = { temperature: 0, topP: 0.1, topK: 1, candidateCount: 1 };
  if (expectedSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = convertToGeminiSchema(expectedSchema);
  }

  const geminiModel = genAI.getGenerativeModel({
    model,
    generationConfig,
  });

  const prompt = `${systemPrompt}\n\n${userPrompt}`;
  const result = await geminiModel.generateContent(prompt);
  const text = result.response.text();
  if (!text || text.trim().length === 0) {
    throw new Error(`${model} returned empty response`);
  }
  return text;
}

// o-series reasoning models (o1, o3-mini, etc.) do not accept a `temperature`
// parameter — passing it causes a 400 error. Detect them by model name prefix.
function isReasoningModel(model: string): boolean {
  return /^o\d/i.test(model);
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  expectedSchema?: any
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const client = new OpenAI({ apiKey });

  const resolved = expectedSchema ? JSON.stringify(resolveJsonSchema(expectedSchema)) : null;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: expectedSchema
        ? `${systemPrompt}\n\nYou must respond with valid JSON matching this exact schema — no markdown, no code fences:\n${resolved}`
        : systemPrompt,
    },
    { role: "user", content: userPrompt },
  ];

  // Reasoning models don't support temperature; standard models default to 0.1
  const config: any = { model, messages };
  if (!isReasoningModel(model)) config.temperature = 0.1;
  if (expectedSchema) config.response_format = { type: "json_object" };

  const response = await client.chat.completions.create(config);
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`${model} returned empty response`);
  return content;
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  expectedSchema?: any,
  maxTokens?: number,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ apiKey });
  const cappedMaxTokens = maxTokens && maxTokens > 0 ? maxTokens : 16384;

  if (expectedSchema) {
    const resolved = resolveJsonSchema(expectedSchema);
    const toolDef = {
      name: "structured_output",
      description: "Return structured data matching the required schema",
      input_schema: resolved,
    };

    const response = await client.messages.create({
      model,
      max_tokens: cappedMaxTokens,
      temperature: 0.1,
      system: systemPrompt,
      tools: [toolDef as any],
      tool_choice: { type: "tool" as const, name: "structured_output" },
      messages: [{ role: "user", content: userPrompt }],
    });

    const toolBlock = response.content.find((b: any) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error(`${model} did not return a tool_use block`);
    }
    return JSON.stringify(toolBlock.input);
  }

  const response = await client.messages.create({
    model,
    max_tokens: cappedMaxTokens,
    temperature: 0.1,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b: any) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error(`${model} returned no text content`);
  }
  return textBlock.text;
}

async function callDeepSeek(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  expectedSchema?: any
): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });

  const resolved = expectedSchema ? JSON.stringify(resolveJsonSchema(expectedSchema)) : null;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: expectedSchema
        ? `${systemPrompt}\n\nIMPORTANT: You must output valid json matching this exact schema — no markdown, no code fences, only raw JSON:\n${resolved}`
        : systemPrompt,
    },
    { role: "user", content: userPrompt },
  ];

  const config: any = { model, messages, temperature: 0.1 };
  if (expectedSchema) {
    config.response_format = { type: "json_object" };
  }

  const response = await client.chat.completions.create(config);
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`${model} returned empty response`);
  return content;
}

export interface AIMetadata {
  provider: string;
  model: string;
  durationMs: number;
  requestId?: string;
  promptVersion?: string;
  promptHash?: string;
  retryCount?: number;
  cached?: boolean;
  taskType?: string;
}

export interface AIResult {
  data: string;
  metadata: AIMetadata;
}

/**
 * Optional per-call controls. All fields are additive — omitting the options
 * argument preserves existing behaviour exactly.
 */
export interface AICallOptions {
  /** Idempotency key. If supplied, identical requests return the cached
   *  result instead of re-running inference. */
  idempotencyKey?: string;
  /** Mark this call as deterministic and cacheable for `ttlMs` ms. */
  cacheable?: boolean;
  cacheTtlMs?: number;
  /** Task type — drives cost guardrails (max_tokens caps). */
  taskType?: string;
  /** Stable identifier for the prompt; recorded in telemetry. */
  promptVersion?: string;
  /** Correlation id linking together AI calls within one request. */
  parentRequestId?: string;
  /** Prompt registry id for telemetry (e.g. "soma.maker"). */
  promptId?: string;
  /** Override max_tokens for providers that need it (clamped by guardrails). */
  maxTokens?: number;
  /** App-level operation label for the admin dashboard breakdown. */
  route?: string;
  /** Already-anonymised user id (e.g. internal user uuid) for per-user costs. */
  userId?: string;
}

function getProviderTimeoutMs(provider: string): number {
  switch (provider) {
    case "anthropic":
      return 60_000;
    case "google":
      return 45_000;
    case "deepseek":
    case "openai":
      return 45_000;
    default:
      return 30_000;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Record a cache-hit row in `ai_usage_logs` so the super-admin dashboard can
 * actually see when the orchestrator served a request from memory instead of
 * paying the LLM. Costs and tokens are zero by definition; latency is just
 * the cache lookup time. Telemetry must never throw — the call path has
 * already produced a usable result.
 */
function recordCacheHit(args: {
  scope: "idempotency" | "subflow";
  cached: AIResult;
  systemPrompt: string;
  userPrompt: string;
  options: AICallOptions | undefined;
  parentRequestId: string;
  startedAt: number;
}): void {
  try {
    recordCall({
      requestId: args.parentRequestId,
      parentRequestId: args.parentRequestId,
      idempotencyKey: args.options?.idempotencyKey ?? null,
      provider: args.cached.metadata.provider,
      model: args.cached.metadata.model,
      taskType: args.options?.taskType ?? args.cached.metadata.taskType ?? null,
      promptVersion: args.options?.promptVersion ?? args.cached.metadata.promptVersion ?? null,
      route: args.options?.route ?? null,
      userId: args.options?.userId ?? null,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      startedAt: args.startedAt,
      endedAt: Date.now(),
      retryCount: 0,
      cached: true,
      inputTokens: 0,
      outputTokens: 0,
      parse: { status: "skipped" },
      validation: { status: "skipped" },
    });
  } catch {
    // never poison the call path
  }
}

export async function generateWithFallback(
  systemPrompt: string,
  userPrompt: string,
  expectedSchema?: any,
  options?: AICallOptions,
): Promise<AIResult> {
  const parentRequestId = options?.parentRequestId ?? newRequestId();
  const promptHash = hashPayload(systemPrompt, " ", userPrompt);
  const taskType = options?.taskType;
  const maxTokensCap = clampMaxTokens(options?.maxTokens, taskType);

  // ── Idempotency: identical request_key returns the cached result. ──────
  if (options?.idempotencyKey) {
    const idemKey = cache.buildCacheKey({
      scope: "idempotency",
      inputHash: hashPayload(promptHash, " ", options.idempotencyKey),
      promptVersion: options.promptVersion,
      model: null,
    });
    const lookupStart = Date.now();
    const cached = cache.get<AIResult>(idemKey);
    if (cached) {
      recordCacheHit({
        scope: "idempotency",
        cached,
        systemPrompt,
        userPrompt,
        options,
        parentRequestId,
        startedAt: lookupStart,
      });
      return { ...cached, metadata: { ...cached.metadata, cached: true, requestId: parentRequestId } };
    }
    const fresh = await runChain(systemPrompt, userPrompt, expectedSchema, options, parentRequestId, promptHash, maxTokensCap);
    cache.set(idemKey, fresh, options.cacheTtlMs ?? cache.CacheTTL.IDEMPOTENCY);
    return fresh;
  }

  // ── Optional deterministic-subflow caching. ────────────────────────────
  if (options?.cacheable) {
    const cacheKey = cache.buildCacheKey({
      scope: "subflow",
      inputHash: promptHash,
      promptVersion: options.promptVersion,
      model: null,
    });
    const lookupStart = Date.now();
    const cached = cache.get<AIResult>(cacheKey);
    if (cached) {
      recordCacheHit({
        scope: "subflow",
        cached,
        systemPrompt,
        userPrompt,
        options,
        parentRequestId,
        startedAt: lookupStart,
      });
      return { ...cached, metadata: { ...cached.metadata, cached: true, requestId: parentRequestId } };
    }
    const fresh = await runChain(systemPrompt, userPrompt, expectedSchema, options, parentRequestId, promptHash, maxTokensCap);
    cache.set(cacheKey, fresh, options.cacheTtlMs ?? cache.CacheTTL.VERIFIER);
    return fresh;
  }

  return runChain(systemPrompt, userPrompt, expectedSchema, options, parentRequestId, promptHash, maxTokensCap);
}

async function runChain(
  systemPrompt: string,
  userPrompt: string,
  expectedSchema: any | undefined,
  options: AICallOptions | undefined,
  parentRequestId: string,
  promptHash: string,
  maxTokensCap: number,
): Promise<AIResult> {
  const orderedChain = health.reorderByHealth(AI_FALLBACK_CHAIN);
  let attempt = 0;

  for (const config of orderedChain) {
    const requestId = newRequestId();
    const startTime = Date.now();
    let endTime = startTime;
    let timedOut = false;
    let raw: string | null = null;
    let errorMessage: string | null = null;

    try {
      let result: string;
      const timeoutLabel = `${config.provider}/${config.model}`;
      const timeoutMs = getProviderTimeoutMs(config.provider);
      switch (config.provider) {
        case "google":
          result = await withTimeout(callGoogle(config.model, systemPrompt, userPrompt, expectedSchema), timeoutMs, timeoutLabel);
          break;
        case "openai":
          result = await withTimeout(callOpenAI(config.model, systemPrompt, userPrompt, expectedSchema), timeoutMs, timeoutLabel);
          break;
        case "anthropic": {
          const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          // Cap is already clamped to the task-type ceiling by clampMaxTokens.
          // Use 4096 only as a sane default when no task type was supplied.
          const anthropicMaxTokens = maxTokensCap || 4096;

          let anthropicResponse: any;
          if (expectedSchema) {
            const msg = await withTimeout(anthropic.messages.create({
              model: config.model,
              max_tokens: anthropicMaxTokens,
              temperature: 0.1,
              system: systemPrompt,
              messages: [{ role: "user", content: userPrompt }],
              tools: [{
                name: "generate_structured_data",
                description: "Generate output adhering to the required JSON schema.",
                input_schema: expectedSchema as any,
              }],
              tool_choice: { type: "tool" as const, name: "generate_structured_data" },
            }), timeoutMs, timeoutLabel);

            const toolBlock = msg.content.find((block: any) => block.type === "tool_use");
            if (!toolBlock) throw new Error("Anthropic failed to use the structured data tool.");
            anthropicResponse = (toolBlock as any).input;
          } else {
            const msg = await withTimeout(anthropic.messages.create({
              model: config.model,
              max_tokens: anthropicMaxTokens,
              temperature: 0.1,
              system: systemPrompt,
              messages: [{ role: "user", content: userPrompt }],
            }), timeoutMs, timeoutLabel);
            const textBlock = msg.content[0];
            anthropicResponse = textBlock.type === "text" ? textBlock.text : "";
          }

          result = typeof anthropicResponse === "string" ? anthropicResponse : JSON.stringify(anthropicResponse);
          break;
        }
        case "deepseek":
          result = await withTimeout(callDeepSeek(config.model, systemPrompt, userPrompt, expectedSchema), timeoutMs, timeoutLabel);
          break;
        default:
          continue;
      }
      endTime = Date.now();
      raw = result;
      const durationMs = endTime - startTime;

      health.recordSuccess(config.provider, config.model, durationMs);
      recordCall({
        requestId,
        parentRequestId,
        idempotencyKey: options?.idempotencyKey ?? null,
        provider: config.provider,
        model: config.model,
        taskType: options?.taskType ?? null,
        promptVersion: options?.promptVersion ?? null,
        route: options?.route ?? null,
        userId: options?.userId ?? null,
        systemPrompt,
        userPrompt,
        startedAt: startTime,
        endedAt: endTime,
        retryCount: attempt,
        timedOut: false,
        rawResponse: result,
        parse: { status: "skipped" },
        validation: { status: "skipped" },
        outputTokens: approxTokens(result),
      });

      return {
        data: result,
        metadata: {
          provider: config.provider,
          model: config.model,
          durationMs,
          requestId,
          promptVersion: options?.promptVersion,
          promptHash,
          retryCount: attempt,
          taskType: options?.taskType,
          cached: false,
        },
      };
    } catch (error: any) {
      endTime = Date.now();
      errorMessage = error?.message || String(error);
      timedOut = /timed out/i.test(errorMessage || "");
      health.recordFailure(config.provider, config.model, timedOut ? "timeout" : "other");
      recordCall({
        requestId,
        parentRequestId,
        idempotencyKey: options?.idempotencyKey ?? null,
        provider: config.provider,
        model: config.model,
        taskType: options?.taskType ?? null,
        promptVersion: options?.promptVersion ?? null,
        route: options?.route ?? null,
        userId: options?.userId ?? null,
        systemPrompt,
        userPrompt,
        startedAt: startTime,
        endedAt: endTime,
        retryCount: attempt,
        timedOut,
        rawResponse: raw,
        parse: { status: raw ? "skipped" : "skipped" },
        validation: { status: "skipped" },
        error: errorMessage,
      });
      console.warn(`[${config.provider} - ${config.model}] failed: ${errorMessage}. Attempting next model...`);
      attempt++;
    }
  }

  throw new Error("All AI providers and fallback models are currently exhausted.");
}
