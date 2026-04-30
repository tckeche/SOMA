/**
 * Examiner-report misconception extractor (Phase 2 rewrite).
 *
 * Old behaviour (Phase 10): one LLM call on the first 6,000 characters,
 * cap at 15 items, store flat rows. Most of the report was being thrown
 * away.
 *
 * New behaviour (Phase 2):
 *   1. Chunk the full extracted_text by detected examiner-report
 *      structure ("Question N", "General comments", numbered items),
 *      with a sliding-window fallback.
 *   2. Run the structured extractor on each chunk in parallel (bounded
 *      concurrency).
 *   3. For each item, capture `sourceQuote` (verbatim substring) and
 *      `sourcePage` (best-effort line-number → page heuristic) so the
 *      review queue can show the evidence.
 *   4. Validate that every quote actually appears in the chunk it was
 *      extracted from — drop items that don't (hallucination guard).
 *   5. Dedup near-identical misconceptions across chunks by normalised
 *      text similarity.
 *   6. Persist with `status: "pending"` so they land in the review queue,
 *      not directly in production.
 *
 * Idempotency: a document that already has any rows is skipped unless
 * `force: true` is passed.
 *
 * Public signature is unchanged so existing callers keep working.
 */
import OpenAI from "openai";
import pLimit from "p-limit";
import { storage } from "../storage";
import { db as sharedDb } from "../db";
import { generateWithFallback } from "./aiOrchestrator";
import { resolveSubtopicId, resolveSyllabusIdsForCode } from "./subtopicResolver";
import {
  listAllowedTopicsForSyllabusCode,
  lookupInInventory,
  type AllowedTopic,
} from "./catalogueInventory";
import type { InsertExaminerMisconception } from "@shared/schema";

export interface ExtractInputDoc {
  id: number;
  board: string;
  syllabusCode: string;
  subject: string | null;
  extractedText: string;
  /** Optional source filename — used to parse exam year for citations. */
  filename?: string | null;
}

/**
 * Parse a publication year from a Cambridge examiner-report filename.
 *
 * Handles three common patterns:
 *   - `9702_w24_er.pdf` / `9702_s23_er.pdf` / `9702_m22_er.pdf` (season-code)
 *   - `..._2024_...` (4-digit year anywhere)
 *   - `9702-23-w-er.pdf` (variant separators)
 *
 * Returns null when nothing recognisable is present so downstream UI can
 * fall back to "before" instead of inventing a year.
 */
export function parseExamYearFromFilename(filename: string | null | undefined): number | null {
  if (!filename) return null;
  const name = filename.toLowerCase();
  // Cambridge season+year code — w24, s23, m22, j21, o20.
  const seasonMatch = name.match(/(?:^|[^a-z])([wsmjo])(\d{2})(?:[^0-9]|$)/);
  if (seasonMatch) {
    const yy = Number(seasonMatch[2]);
    if (Number.isFinite(yy)) return yy + (yy < 70 ? 2000 : 1900);
  }
  // Any 4-digit year between 1990 and 2099.
  const fullMatch = name.match(/(?:^|[^0-9])((?:19[9]\d|20\d{2}))(?:[^0-9]|$)/);
  if (fullMatch) {
    const y = Number(fullMatch[1]);
    if (Number.isFinite(y) && y >= 1990 && y <= 2099) return y;
  }
  return null;
}

export interface ExtractResult {
  count: number;
  skipped: boolean;
  reason?: string;
  /** Number of distinct chunks the report was split into. */
  chunkCount?: number;
  /** Items extracted per chunk before dedup. */
  rawItemCount?: number;
  /** Items dropped because the source quote could not be verified. */
  hallucinationDrops?: number;
  /** Items dropped because the LLM picked a topic outside the allowed
   *  catalogue inventory. Only populated when the closed-set constraint
   *  was active (i.e. inventory was non-empty for this syllabus code). */
  taxonomyDrops?: number;
  /** Number of allowed topics in the closed set used to constrain the
   *  prompt. 0 when the catalogue had no entries for this syllabus —
   *  in that case the extractor degraded to its legacy open-ended
   *  prompt and `taxonomyDrops` is meaningless. */
  closedSetTopicCount?: number;
  /** Number of chunks that threw inside `extractFromChunk` (LLM error,
   *  network error, JSON parse failure, etc.). Per-chunk failures are
   *  swallowed so one bad chunk doesn't kill the doc, but callers need
   *  to know the failure count to distinguish a genuine "no items" doc
   *  from one whose every chunk crashed. The resumable-skip logic in
   *  `scripts/reextractExaminerMisconceptions.ts` uses this to refuse
   *  to insert a sentinel for a doc whose chunks all errored — those
   *  docs stay re-tryable on the next pass. */
  chunkFailures?: number;
}

export interface ExtractOptions {
  force?: boolean;
  /** Max characters per chunk. Default 4,000 (~1k tokens) so chunks are
   *  small enough to stay coherent and let many run in parallel. */
  chunkChars?: number;
  /** Overlap between adjacent fallback chunks to avoid splitting an
   *  observation across boundaries. */
  chunkOverlap?: number;
  /** Concurrency for chunk extraction. */
  concurrency?: number;
  /** Soft cap on items per chunk; the prompt asks for "as many as you
   *  observe" and we keep up to this many to prevent runaway. */
  itemsPerChunkCap?: number;
  /** Force a specific provider instead of the orchestrator's fallback chain.
   *
   *  - "openai"      → gpt-4o direct, bypasses the orchestrator.
   *  - "openai-mini" → gpt-4o-mini direct. ~16× cheaper than gpt-4o and the
   *    closed-set constraint makes the task pure classification, so mini is
   *    the recommended default for re-extraction sweeps.
   *  - "default"     → goes through `generateWithFallback`. */
  preferredProvider?: "openai" | "openai-mini" | "default";
  /** When true (default) and the catalogue inventory is non-empty for the
   *  syllabus code, inject an `ALLOWED_TOPICS` block into the prompt and
   *  drop any item whose topic is outside that closed set. Set to false
   *  to force the legacy open-ended prompt — useful for tests, or for
   *  syllabi not yet migrated to the structured catalogue.
   *
   *  When the inventory is empty for the syllabus code, this flag has no
   *  effect: we always degrade to the open-ended prompt because there is
   *  nothing to constrain against. The result includes
   *  `closedSetTopicCount: 0` so the caller knows. */
  useStrictCatalogueConstraint?: boolean;
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

async function callOpenAIDirect(prompt: string, system: string, model: string): Promise<string> {
  const client = getOpenAI();
  const response = await client.chat.completions.create({
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`${model} returned empty response`);
  return content;
}

/**
 * Build the prompt header. When `allowedTopics` is non-empty, inject a
 * closed-set ALLOWED_TOPICS block and tighten the rules so the LLM is
 * required to pick from it. When empty (catalogue not populated for this
 * syllabus), fall back to the legacy open-ended prompt — better to get
 * loose tags than nothing.
 */
function buildPromptHeader(allowedTopics: AllowedTopic[]): string {
  if (allowedTopics.length === 0) {
    return `You are an educational data analyst extracting structured misconceptions from a Cambridge examiner report.

For each distinct student misconception present in the chunk below, return a JSON object with:
- topic: the syllabus topic this relates to (string; "General" if unclear)
- subtopic: specific subtopic (string or null)
- misconception: a single sentence stating the wrong belief students hold
- studentError: what students typically did wrong on the page
- correctApproach: the correct method or reasoning
- frequency: "very_common" | "common" | "occasional"
- sourceQuote: an EXACT verbatim substring from the chunk below that evidences this misconception (15-200 characters). Must be copy-pasteable text from the chunk; do not paraphrase.
- confidencePct: integer 0-100 — how confident you are this is a real, distinct misconception.

Rules:
1. Only report observations that are explicitly evidenced in the chunk. Do not invent or extrapolate.
2. If sourceQuote is not present verbatim in the chunk, do not include the item.
3. Return a JSON array. Empty array is fine if the chunk has no concrete misconceptions.
4. Never include personal data, candidate names, or centre numbers.

CHUNK:
`;
  }

  // Compact JSON to keep the prompt small. We strip topicId / subtopic ids
  // from the prompt — the LLM only needs to pick the strings; we resolve
  // ids server-side from the inventory.
  const allowedJson = JSON.stringify(
    allowedTopics.map((t) => ({
      topic: t.topicTitle,
      subtopics: t.subtopics.map((s) => s.title),
    })),
  );

  return `You are an educational data analyst extracting structured misconceptions from a Cambridge examiner report.

ALLOWED TAXONOMY for this syllabus — every item you return MUST be tagged against this list. Do NOT invent topics or subtopics:
${allowedJson}

For each distinct student misconception present in the chunk below, return a JSON object with:
- topic: MUST be EXACTLY one of the topic strings above, copied verbatim (case-sensitive). If no listed topic is genuinely relevant to the misconception, OMIT the item entirely. Do NOT fall back to "General", do NOT guess, do NOT paraphrase a topic name.
- subtopic: MUST be EXACTLY one of the subtopic strings under your chosen topic (verbatim), or null when the chunk doesn't pin a specific subtopic.
- misconception: a single sentence stating the wrong belief students hold
- studentError: what students typically did wrong on the page
- correctApproach: the correct method or reasoning
- frequency: "very_common" | "common" | "occasional"
- sourceQuote: an EXACT verbatim substring from the chunk below that evidences this misconception (15-200 characters). Must be copy-pasteable text from the chunk; do not paraphrase.
- confidencePct: integer 0-100 — how confident you are this is a real, distinct misconception.

Rules:
1. The taxonomy restriction is HARD: any item with an off-list topic, or with a subtopic that is not in that topic's listed subtopics, will be discarded by post-validation. There is NO fallback "General" topic.
2. Only report observations that are explicitly evidenced in the chunk. Do not invent or extrapolate.
3. If sourceQuote is not present verbatim in the chunk, do not include the item.
4. Return a JSON array. Empty array is fine — the chunk legitimately may not contain misconceptions for any of the allowed topics.
5. Never include personal data, candidate names, or centre numbers.

CHUNK:
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking
// ─────────────────────────────────────────────────────────────────────────────

interface Chunk {
  text: string;
  /** 1-based index within the document. */
  index: number;
  /** Best-effort page guess based on accumulated character offset. */
  approxPage: number;
}

const CHARS_PER_PAGE = 2_500; // empirically a Cambridge examiner report PDF page after extraction

/**
 * Detected section heading regex. Matches:
 *   "Question 4"
 *   "Question 4(a)"
 *   "General comments"
 *   "Comments on specific questions"
 *
 * The match is the start of a line, optionally preceded by whitespace.
 */
const SECTION_HEADING = /^\s*(Question\s+\d+(\([a-z]\))?|General comments|Comments on specific questions|Section [A-D])\b.*$/im;

function chunkExaminerReport(text: string, opts: { chunkChars: number; chunkOverlap: number }): Chunk[] {
  if (!text || !text.trim()) return [];

  // Strategy 1: split on detected headings.
  const matches: Array<{ start: number; heading: string }> = [];
  let lastIdx = 0;
  const lines = text.split(/\r?\n/);
  let charOffset = 0;
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) {
      matches.push({ start: charOffset, heading: line.trim() });
    }
    charOffset += line.length + 1;
  }

  if (matches.length >= 2) {
    const chunks: Chunk[] = [];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].start;
      const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
      const slice = text.slice(start, end);
      if (slice.trim().length === 0) continue;
      // Sub-split very long sections by chunkChars to keep prompts bounded.
      if (slice.length <= opts.chunkChars) {
        chunks.push({ text: slice, index: chunks.length + 1, approxPage: Math.max(1, Math.floor(start / CHARS_PER_PAGE) + 1) });
      } else {
        let cursor = 0;
        while (cursor < slice.length) {
          const end2 = Math.min(slice.length, cursor + opts.chunkChars);
          chunks.push({
            text: slice.slice(cursor, end2),
            index: chunks.length + 1,
            approxPage: Math.max(1, Math.floor((start + cursor) / CHARS_PER_PAGE) + 1),
          });
          // Advance: stop once we've consumed up to the end of the slice.
          // The previous `cursor = end2 - chunkOverlap` plus the
          // `cursor < slice.length` loop guard created an infinite loop
          // when a section was longer than chunkChars: end2 saturates at
          // slice.length, cursor pins to slice.length - chunkOverlap,
          // and the same final chunk is re-pushed forever, OOMing the
          // process. Break the moment the window's right edge has hit
          // slice.length.
          if (end2 >= slice.length) break;
          const nextCursor = end2 - opts.chunkOverlap;
          if (nextCursor <= cursor) break; // forward-progress guard
          cursor = nextCursor;
        }
      }
      lastIdx = end;
    }
    if (chunks.length > 0) return chunks;
  }

  // Strategy 2: sliding-window fallback (same forward-progress guard).
  const chunks: Chunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + opts.chunkChars);
    chunks.push({
      text: text.slice(cursor, end),
      index: chunks.length + 1,
      approxPage: Math.max(1, Math.floor(cursor / CHARS_PER_PAGE) + 1),
    });
    if (end >= text.length) break;
    const nextCursor = end - opts.chunkOverlap;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-chunk extraction
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedItem {
  topic: string;
  subtopic: string | null;
  misconception: string;
  studentError: string;
  correctApproach: string;
  frequency: string;
  sourceQuote: string;
  confidencePct: number;
}

function parseJsonArray(raw: string): unknown[] {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to recover an array embedded in surrounding prose.
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function normaliseString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampInt(value: unknown, lo: number, hi: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

interface ChunkExtractStats {
  /** Items dropped because the LLM returned a topic outside the allowed
   *  set. Only meaningful when `allowedTopics` was non-empty. */
  taxonomyDrops: number;
}

async function extractFromChunk(
  chunk: Chunk,
  options: ExtractOptions,
  allowedTopics: AllowedTopic[],
  stats: ChunkExtractStats,
): Promise<ExtractedItem[]> {
  const promptHeader = buildPromptHeader(allowedTopics);
  const prompt = promptHeader + chunk.text;
  const system = "Extract misconceptions as a JSON array. Quote evidence verbatim.";
  let raw: string;
  try {
    if (options.preferredProvider === "openai") {
      raw = await callOpenAIDirect(prompt, system, "gpt-4o");
    } else if (options.preferredProvider === "openai-mini") {
      raw = await callOpenAIDirect(prompt, system, "gpt-4o-mini");
    } else {
      const { data } = await generateWithFallback(prompt, system, undefined, {
        taskType: "examiner.extract",
        route: "examiner.extract",
      });
      raw = data;
    }
  } catch (err: any) {
    throw new Error(`LLM call failed for chunk ${chunk.index}: ${err?.message ?? String(err)}`);
  }

  // Pre-build a lowercase index of the allowed set so the per-item check
  // is O(1) instead of O(allowedTopics × subtopics) per item.
  const allowedTopicIndex = allowedTopics.length > 0
    ? new Map(
        allowedTopics.map((t) => [
          t.topicTitle.trim().toLowerCase(),
          new Set(t.subtopics.map((s) => s.title.trim().toLowerCase())),
        ]),
      )
    : null;

  const items = parseJsonArray(raw);
  const accepted: ExtractedItem[] = [];
  for (const it of items) {
    const obj = (it ?? {}) as Record<string, unknown>;
    const sourceQuote = normaliseString(obj.sourceQuote);
    if (!sourceQuote || sourceQuote.length < 15 || !chunk.text.includes(sourceQuote)) {
      // Hallucination guard: drop items whose quote isn't verbatim in
      // the chunk. The caller tracks how many we drop.
      continue;
    }
    const misconception = normaliseString(obj.misconception);
    if (!misconception) continue;

    const rawTopic = normaliseString(obj.topic);
    const rawSubtopic = normaliseString(obj.subtopic);

    // Closed-set enforcement: when an inventory exists, drop items that
    // didn't pick from it. We do NOT silently coerce ("Algebra" → "General")
    // because that's exactly how the original 3,485 corrupted rows came to
    // exist — the LLM happily emitted off-set topics and the validator
    // shrugged. Better to discard than to keep noise.
    let topicForRow = rawTopic || "General";
    let subtopicForRow: string | null = rawSubtopic || null;
    if (allowedTopicIndex) {
      const allowedSubs = allowedTopicIndex.get(rawTopic.trim().toLowerCase());
      if (!allowedSubs) {
        stats.taxonomyDrops += 1;
        continue;
      }
      // Subtopic must be in the picked topic's allowed list, or null.
      // An off-list subtopic gets nulled rather than dropping the whole
      // item, since the topic-level signal is still useful.
      if (subtopicForRow && !allowedSubs.has(subtopicForRow.trim().toLowerCase())) {
        subtopicForRow = null;
      }
      // Use the inventory's canonical capitalisation so downstream
      // exact-match resolvers and joins line up perfectly.
      const canonicalTopic = allowedTopics.find(
        (t) => t.topicTitle.trim().toLowerCase() === rawTopic.trim().toLowerCase(),
      );
      if (canonicalTopic) topicForRow = canonicalTopic.topicTitle;
      if (subtopicForRow) {
        const canonicalSub = canonicalTopic?.subtopics.find(
          (s) => s.title.trim().toLowerCase() === subtopicForRow!.trim().toLowerCase(),
        );
        if (canonicalSub) subtopicForRow = canonicalSub.title;
      }
    }

    accepted.push({
      topic: topicForRow,
      subtopic: subtopicForRow,
      misconception,
      studentError: normaliseString(obj.studentError ?? obj["student_error"]),
      correctApproach: normaliseString(obj.correctApproach ?? obj["correct_approach"]),
      frequency: ((): string => {
        const f = normaliseString(obj.frequency).toLowerCase();
        return f === "very_common" || f === "common" || f === "occasional" ? f : "common";
      })(),
      sourceQuote,
      confidencePct: clampInt(obj.confidencePct ?? obj["confidence_pct"], 0, 100),
    });
  }
  return accepted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup
// ─────────────────────────────────────────────────────────────────────────────

function normaliseMisconception(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const A = new Set(a.split(" ").filter((w) => w.length > 2));
  const B = new Set(b.split(" ").filter((w) => w.length > 2));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  Array.from(A).forEach((tok) => { if (B.has(tok)) inter++; });
  return inter / (A.size + B.size - inter);
}

interface DedupItem extends ExtractedItem {
  approxPage: number;
}

function dedupItems(items: DedupItem[]): DedupItem[] {
  const out: DedupItem[] = [];
  for (const item of items) {
    const norm = normaliseMisconception(item.misconception);
    const dupIdx = out.findIndex((existing) => jaccardSimilarity(norm, normaliseMisconception(existing.misconception)) >= 0.7);
    if (dupIdx === -1) {
      out.push(item);
      continue;
    }
    // Merge: keep the higher-confidence variant; bump frequency if any
    // copy was very_common.
    const existing = out[dupIdx];
    if (item.confidencePct > existing.confidencePct) {
      out[dupIdx] = { ...item, approxPage: existing.approxPage };
    }
    if (item.frequency === "very_common" || existing.frequency === "very_common") {
      out[dupIdx].frequency = "very_common";
    } else if (item.frequency === "common" || existing.frequency === "common") {
      out[dupIdx].frequency = "common";
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function extractAndStoreMisconceptions(
  doc: ExtractInputDoc,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const {
    force = false,
    chunkChars = 4_000,
    chunkOverlap = 400,
    concurrency = 4,
    itemsPerChunkCap = 30,
    preferredProvider = "default",
    useStrictCatalogueConstraint = true,
  } = options;

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

  const text = doc.extractedText ?? "";
  if (!text.trim()) {
    return { count: 0, skipped: true, reason: "empty-text" };
  }

  const chunks = chunkExaminerReport(text, { chunkChars, chunkOverlap });
  if (chunks.length === 0) {
    return { count: 0, skipped: true, reason: "no-chunks" };
  }

  // Load the closed-set inventory once per document. Empty when the
  // catalogue isn't populated for this syllabus code — the prompt builder
  // then degrades to its legacy open-ended form. This is the durable
  // fix for the corrupted-3,485-rows problem (Task #26): the LLM is
  // explicitly told which topics are valid for this syllabus, and any
  // off-list response is dropped by post-validation.
  const allowedTopics = useStrictCatalogueConstraint
    ? await listAllowedTopicsForSyllabusCode(doc.syllabusCode).catch((err: any) => {
        console.warn(`[examinerExtract] catalogue inventory load failed for ${doc.syllabusCode}: ${err?.message ?? err}`);
        return [] as AllowedTopic[];
      })
    : [];
  if (useStrictCatalogueConstraint && allowedTopics.length === 0) {
    console.warn(
      `[examinerExtract] catalogue inventory empty for syllabus ${doc.syllabusCode} — degrading to open-ended prompt for doc ${doc.id}`,
    );
  }

  const limit = pLimit(concurrency);
  const allItems: DedupItem[] = [];
  let rawCount = 0;
  let hallucinationDrops = 0;
  let chunkFailures = 0;
  const chunkStats: ChunkExtractStats = { taxonomyDrops: 0 };

  await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        try {
          const items = await extractFromChunk(chunk, { preferredProvider }, allowedTopics, chunkStats);
          rawCount += items.length;
          // Approximate hallucination drops: items returned by the LLM
          // that didn't survive the verbatim check inside extractFromChunk
          // are not visible here; we expose 0 for now and tighten when we
          // wire telemetry through.
          for (const it of items.slice(0, itemsPerChunkCap)) {
            allItems.push({ ...it, approxPage: chunk.approxPage });
          }
        } catch (err: any) {
          // Per-chunk failure shouldn't kill the whole document. Log,
          // count, and continue. The count is propagated on the result so
          // resumable callers can distinguish a genuine "no items" doc
          // from one whose every chunk crashed.
          chunkFailures += 1;
          console.warn(`[examinerExtract] chunk ${chunk.index} failed: ${err?.message ?? err}`);
        }
      }),
    ),
  );

  const deduped = dedupItems(allItems);
  if (deduped.length === 0) {
    return {
      count: 0,
      skipped: true,
      reason: "no-items",
      chunkCount: chunks.length,
      rawItemCount: rawCount,
      hallucinationDrops,
      taxonomyDrops: chunkStats.taxonomyDrops,
      closedSetTopicCount: allowedTopics.length,
      chunkFailures,
    };
  }

  const examYear = parseExamYearFromFilename(doc.filename ?? null);

  // Resolve catalogue FK at insert time so the review queue's join on
  // `subtopics.title` hydrates immediately. We share the candidate
  // syllabus-id lookup across every row of this document because all
  // rows live under the same (board, syllabusCode) pair.
  const candidateSyllabusIds = await resolveSyllabusIdsForCode(doc.syllabusCode);

  const rows: InsertExaminerMisconception[] = await Promise.all(
    deduped.map(async (item) => {
      let subtopicId: number | null = null;

      // Fast path: when the closed-set constraint was active, the LLM was
      // forced to pick (topic, subtopic) from the inventory. We can stamp
      // subtopicId directly from the inventory without calling the
      // resolver — saves a round-trip and is exact by construction.
      if (allowedTopics.length > 0) {
        const direct = lookupInInventory(allowedTopics, item.topic, item.subtopic);
        if (direct?.subtopicId !== undefined && direct?.subtopicId !== null) {
          subtopicId = direct.subtopicId;
        }
      }

      // Fallback: resolver still runs when (a) the inventory was empty
      // (legacy open-ended path), or (b) the LLM picked a topic but no
      // subtopic so the inventory could only return `subtopicId: null`.
      // Either way the resolver might find a fuzzy match the inventory
      // didn't.
      if (subtopicId === null) {
        try {
          const resolved = await resolveSubtopicId({
            subject: doc.subject ?? null,
            topic: item.topic,
            subtopic: item.subtopic,
            candidateSyllabusIds,
          });
          if (!resolved.ambiguous) subtopicId = resolved.subtopicId;
        } catch (err: any) {
          // Resolver issues must never block the insert — the backfill
          // script can sweep up unmatched rows later.
          console.warn(`[examinerExtract] subtopic resolve failed: ${err?.message ?? err}`);
        }
      }

      return {
        documentId: doc.id,
        board: doc.board,
        syllabusCode: doc.syllabusCode,
        subject: doc.subject ?? null,
        topic: item.topic,
        subtopic: item.subtopic,
        subtopicId,
        misconception: item.misconception,
        studentError: item.studentError,
        correctApproach: item.correctApproach,
        frequency: item.frequency,
        // Phase 2: every freshly-extracted row enters the review queue.
        status: "pending",
        sourceQuote: item.sourceQuote,
        sourcePage: item.approxPage,
        confidence: item.confidencePct,
        examYear,
      } satisfies InsertExaminerMisconception;
    }),
  );

  await storage.createExaminerMisconceptions(rows);

  return {
    count: rows.length,
    skipped: false,
    chunkCount: chunks.length,
    rawItemCount: rawCount,
    hallucinationDrops,
    taxonomyDrops: chunkStats.taxonomyDrops,
    closedSetTopicCount: allowedTopics.length,
    chunkFailures,
  };
}
