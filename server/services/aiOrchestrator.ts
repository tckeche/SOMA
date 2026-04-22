import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { recordProviderResult, type AIProvider } from "./aiStatus";
import { zodToJsonSchema } from "zod-to-json-schema";

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
  expectedSchema?: any
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ apiKey });

  if (expectedSchema) {
    const resolved = resolveJsonSchema(expectedSchema);
    const toolDef = {
      name: "structured_output",
      description: "Return structured data matching the required schema",
      input_schema: resolved,
    };

    const response = await client.messages.create({
      model,
      max_tokens: 16384,
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
    max_tokens: 16384,
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
}

export interface AIResult {
  data: string;
  metadata: AIMetadata;
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

const STATUS_TRACKED: Record<string, AIProvider | null> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: null, // not surfaced in the footer
};

export async function generateWithFallback(
  systemPrompt: string,
  userPrompt: string,
  expectedSchema?: any
): Promise<AIResult> {
  for (const config of AI_FALLBACK_CHAIN) {
    const tracked = STATUS_TRACKED[config.provider] ?? null;
    try {
      const startTime = Date.now();
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

          let anthropicResponse: any;
          if (expectedSchema) {
            const msg = await withTimeout(anthropic.messages.create({
              model: config.model,
              max_tokens: 4096,
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
              max_tokens: 4096,
              temperature: 0.1,
              system: systemPrompt,
              messages: [{ role: "user", content: userPrompt }],
            }), timeoutMs, timeoutLabel);
            const textBlock = msg.content[0];
            anthropicResponse = textBlock.type === "text" ? textBlock.text : "";
          }

          const anthropicData = typeof anthropicResponse === "string" ? anthropicResponse : JSON.stringify(anthropicResponse);
          if (tracked) recordProviderResult(tracked, true);
          return { data: anthropicData, metadata: { provider: config.provider, model: config.model, durationMs: Date.now() - startTime } };
        }
        case "deepseek":
          result = await withTimeout(callDeepSeek(config.model, systemPrompt, userPrompt, expectedSchema), timeoutMs, timeoutLabel);
          break;
        default:
          continue;
      }
      const durationMs = Date.now() - startTime;
      if (tracked) recordProviderResult(tracked, true);
      return {
        data: result,
        metadata: { provider: config.provider, model: config.model, durationMs },
      };
    } catch (error: any) {
      if (tracked) recordProviderResult(tracked, false, error);
      console.warn(`[${config.provider} - ${config.model}] failed: ${error.message}. Attempting next model...`);
    }
  }

  throw new Error("All AI providers and fallback models are currently exhausted.");
}
