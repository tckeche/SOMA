/**
 * Reusable misconception extractor — lifted out of `routes.ts` so the
 * doc-intelligence single-upload path and the bulk ingestion script
 * (`scripts/ingestCurriculumDocs.ts`) share one implementation.
 *
 * Calls `generateWithFallback` with the same prompt the doc-intelligence
 * job has been using, parses + sanitises the JSON, and persists rows.
 *
 * Idempotency: if the document already has any misconception rows the
 * function returns `{ skipped: true }` without burning an LLM call. Pass
 * `force: true` to re-extract regardless.
 */
import OpenAI from "openai";
import { storage } from "../storage";
import { db as sharedDb } from "../db";
import { generateWithFallback } from "./aiOrchestrator";

export interface ExtractInputDoc {
  id: number;
  board: string;
  syllabusCode: string;
  subject: string | null;
  extractedText: string;
}

export interface ExtractResult {
  count: number;
  skipped: boolean;
  reason?: string;
}

export interface ExtractOptions {
  force?: boolean;
  sliceLength?: number;
  /** Force a specific provider instead of the orchestrator's fallback chain.
   *  Currently only "openai" (model=gpt-4o) is supported as a single-provider
   *  override; anything else falls back to `generateWithFallback`. */
  preferredProvider?: "openai" | "default";
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

async function callOpenAIDirect(prompt: string, system: string): Promise<string> {
  const client = getOpenAI();
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("gpt-4o returned empty response");
  return content;
}

const PROMPT_HEADER = `You are an educational data analyst. Extract structured misconceptions from the following examiner report.

For each misconception, identify:
- topic: the mathematical/subject topic
- subtopic: specific subtopic (or null)
- misconception: what students commonly get wrong
- studentError: the typical incorrect approach
- correctApproach: what students should do instead
- frequency: "very_common", "common", or "occasional"

Return a JSON array of objects. Extract up to 15 misconceptions. Only real observations from the text.

EXAMINER REPORT TEXT:
`;

export async function extractAndStoreMisconceptions(
  doc: ExtractInputDoc,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const { force = false, sliceLength = 6000, preferredProvider = "default" } = options;

  // Hard guard against silent in-memory persistence. If SUPABASE_URL is set
  // but the shared db handle is null, the storage proxy will lock itself into
  // MemoryStorage and every "saved" row will vanish when the process exits.
  // We refuse to run rather than burn LLM tokens that go nowhere.
  if (process.env.SUPABASE_URL && !sharedDb) {
    throw new Error(
      "extractAndStoreMisconceptions: SUPABASE_URL is set but shared db handle is null. " +
        "Call connectDb() from server/db.ts before invoking this function, " +
        "otherwise inserts go to MemoryStorage and are lost on process exit.",
    );
  }

  if (!force) {
    const existing = await storage.listExaminerMisconceptions({
      board: doc.board,
      syllabusCode: doc.syllabusCode,
    });
    if (existing.some((m) => m.documentId === doc.id)) {
      return { count: 0, skipped: true, reason: "already-extracted" };
    }
  }

  const textSlice = (doc.extractedText ?? "").slice(0, sliceLength);
  if (!textSlice.trim()) {
    return { count: 0, skipped: true, reason: "empty-text" };
  }

  const prompt = PROMPT_HEADER + textSlice;
  const system = "Extract misconceptions as JSON array.";
  let raw: string;
  try {
    if (preferredProvider === "openai") {
      raw = await callOpenAIDirect(prompt, system);
    } else {
      const { data } = await generateWithFallback(prompt, system, undefined);
      raw = data;
    }
  } catch (err: any) {
    throw new Error(`LLM call failed: ${err?.message ?? String(err)}`);
  }

  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  let items: unknown;
  try {
    items = JSON.parse(cleaned);
  } catch (err: any) {
    throw new Error(`JSON parse failed: ${err?.message ?? String(err)}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { count: 0, skipped: true, reason: "no-items" };
  }

  const rows = items.slice(0, 15).map((item: any) => ({
    documentId: doc.id,
    board: doc.board,
    syllabusCode: doc.syllabusCode,
    subject: doc.subject ?? item?.subject ?? null,
    topic: String(item?.topic ?? "General"),
    subtopic: item?.subtopic ?? null,
    misconception: String(item?.misconception ?? ""),
    studentError: String(item?.studentError ?? item?.student_error ?? ""),
    correctApproach: String(item?.correctApproach ?? item?.correct_approach ?? ""),
    frequency: (item?.frequency as string) ?? "common",
  }));

  await storage.createExaminerMisconceptions(rows);
  return { count: rows.length, skipped: false };
}
