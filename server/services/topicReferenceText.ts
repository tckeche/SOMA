/**
 * Phase 7 — Reference text layer (Layer 2 of the two-layer curriculum).
 *
 * Layer 1 (structured catalogue) powers dropdowns, filters, and metadata.
 * Layer 2 (this module) builds the *cleaned text chunk* per topic that can be
 *
 *   (a) embedded for semantic topic search, and
 *   (b) injected into an AI prompt as grounding context.
 *
 * Chunks are keyed by `(topicId, levelTier)` — a topic's AS cut and A2 cut
 * teach different material and must be retrieved independently. IGCSE topics
 * get one chunk per topic tagged "IGCSE".
 *
 * The text is fully deterministic: same inputs → same bytes → same hash. The
 * hash gates embedding regeneration: if a topic's content hasn't changed the
 * existing vector is reused.
 *
 * Pure module — no DB, no network. Callers pass in resolved DTOs.
 */
import { createHash } from "node:crypto";
import type { LevelTier } from "@shared/schema";
import type {
  PaperSummaryDto,
  RequirementDto,
  SubtopicContextDto,
  TopicContextDto,
} from "./syllabusCatalogue";

export interface TopicChunkRefs {
  examiningBody: { slug: string; displayName: string };
  level: { code: string; displayName: string };
  subject: { slug: string; name: string };
  syllabusCode: string;
  syllabusTitle: string;
}

export interface BuildTopicChunkInput extends TopicChunkRefs {
  topic: TopicContextDto;
  tier: LevelTier;
}

export interface TopicChunk {
  topicId: number;
  tier: LevelTier;
  text: string;
  contentHash: string;
  keywords: string[];
  paperNumbers: number[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by",
  "is", "are", "be", "as", "at", "it", "its", "this", "that", "these", "those",
  "their", "them", "they", "we", "us", "our", "i", "you", "your", "he", "she",
  "his", "her", "not", "no", "do", "does", "did", "will", "can", "could",
  "should", "would", "may", "might", "must", "shall", "have", "has", "had",
  "from", "into", "out", "up", "down", "over", "under", "between", "through",
  "using", "use", "used", "about", "such", "so", "than", "then", "also",
  "how", "what", "when", "where", "why", "which", "who", "whom", "if",
  "including", "include", "given", "apply", "applied", "show", "shown",
  "e.g", "eg", "i.e", "ie", "etc", "candidate", "candidates",
]);

function normaliseTierFilter(
  subs: SubtopicContextDto[],
  tier: LevelTier,
): SubtopicContextDto[] {
  return subs.filter((s) => s.levelTier === tier);
}

function stableSortSubs(subs: SubtopicContextDto[]): SubtopicContextDto[] {
  return [...subs].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.subtopicNumber.localeCompare(b.subtopicNumber);
  });
}

function stableSortReqs(reqs: RequirementDto[]): RequirementDto[] {
  return [...reqs].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.statement.localeCompare(b.statement);
  });
}

function stableSortPapers(papers: PaperSummaryDto[]): PaperSummaryDto[] {
  return [...papers].sort((a, b) => {
    if (a.levelTier !== b.levelTier) return a.levelTier.localeCompare(b.levelTier);
    return a.paperNumber - b.paperNumber;
  });
}

function dedupePapers(papers: PaperSummaryDto[]): PaperSummaryDto[] {
  const seen = new Map<string, PaperSummaryDto>();
  for (const p of papers) {
    const key = `${p.levelTier}::${p.paperNumber}::${p.code ?? ""}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return stableSortPapers(Array.from(seen.values()));
}

function collectPapersForTier(
  topic: TopicContextDto,
  subs: SubtopicContextDto[],
  tier: LevelTier,
): PaperSummaryDto[] {
  const bag: PaperSummaryDto[] = [];
  for (const s of subs) {
    for (const p of s.papers) bag.push(p);
  }
  for (const p of topic.papers) {
    if (p.levelTier === tier) bag.push(p);
  }
  return dedupePapers(bag);
}

/**
 * Keyword extraction: lowercase tokens from topic title + subtopic titles +
 * requirement statements, minus stopwords, minus numeric-only tokens, minus
 * tokens shorter than 3 chars. Preserves first-seen order and dedupes.
 */
function extractKeywords(
  topic: TopicContextDto,
  subs: SubtopicContextDto[],
  reqs: RequirementDto[],
  cap = 32,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    for (const rawTok of raw.toLowerCase().split(/[^a-z0-9'\-]+/)) {
      const tok = rawTok.replace(/^['-]+|['-]+$/g, "");
      if (tok.length < 3) continue;
      if (/^\d+$/.test(tok)) continue;
      if (STOPWORDS.has(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= cap) return;
    }
  };
  push(topic.title);
  for (const s of subs) {
    if (out.length >= cap) break;
    push(s.title);
    if (s.description) push(s.description);
  }
  for (const r of reqs) {
    if (out.length >= cap) break;
    push(r.statement);
    if (r.notesAndExamples) push(r.notesAndExamples);
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Build a chunk for a single (topic, tier) pair. Returns null when the topic
 * has no content for the tier — the caller should skip the pair entirely
 * rather than embed an empty chunk.
 */
export function buildTopicChunk(input: BuildTopicChunkInput): TopicChunk | null {
  const subsInTier = stableSortSubs(normaliseTierFilter(input.topic.subtopics, input.tier));
  if (subsInTier.length === 0) return null;

  const reqBag: RequirementDto[] = [];
  const reqKeys = new Set<string>();
  for (const s of subsInTier) {
    for (const r of stableSortReqs(s.requirements)) {
      const key = r.statement.trim().toLowerCase();
      if (!key || reqKeys.has(key)) continue;
      reqKeys.add(key);
      reqBag.push(r);
    }
  }

  const papers = collectPapersForTier(input.topic, subsInTier, input.tier);
  const keywords = extractKeywords(input.topic, subsInTier, reqBag);

  const lines: string[] = [];
  lines.push(`# ${input.topic.topicNumber} ${input.topic.title}`);
  lines.push("");
  lines.push(`Examining body: ${input.examiningBody.displayName} (${input.examiningBody.slug})`);
  lines.push(`Level: ${input.level.displayName} (${input.level.code})`);
  lines.push(`Subject: ${input.subject.name} (${input.subject.slug})`);
  lines.push(`Syllabus: ${input.syllabusCode} — ${input.syllabusTitle}`);
  lines.push(`Stage: ${input.tier}`);
  if (input.topic.strandName) lines.push(`Strand: ${input.topic.strandName}`);
  if (input.topic.description) lines.push(`Topic description: ${input.topic.description}`);

  if (papers.length > 0) {
    const paperStr = papers
      .map((p) => `P${p.paperNumber}${p.code ? ` (${p.code})` : ""} [${p.levelTier}]`)
      .join(", ");
    lines.push(`Assessed on: ${paperStr}`);
  }

  if (keywords.length > 0) {
    lines.push(`Keywords: ${keywords.join(", ")}`);
  }

  lines.push("");
  lines.push(`## Subtopics`);
  for (const s of subsInTier) {
    const tag = s.coreOrExtended ? `[${s.levelTier}/${s.coreOrExtended}]` : `[${s.levelTier}]`;
    lines.push(`- ${s.subtopicNumber} ${s.title} ${tag}`);
    if (s.description) lines.push(`  ${s.description}`);
  }

  if (reqBag.length > 0) {
    lines.push("");
    lines.push(`## Learning requirements`);
    for (const r of reqBag) {
      const cmd = r.commandWord ? `(${r.commandWord}) ` : "";
      lines.push(`- ${cmd}${r.statement}`);
      if (r.notesAndExamples) lines.push(`    Notes: ${r.notesAndExamples}`);
    }
  }

  if (input.topic.competencies.length > 0) {
    const sortedComps = [...input.topic.competencies].sort(
      (a, b) => b.weight - a.weight || a.code.localeCompare(b.code),
    );
    lines.push("");
    lines.push(`## Competencies`);
    for (const c of sortedComps) {
      lines.push(`- ${c.code} ${c.displayName} (weight=${c.weight})`);
    }
  }

  const text = lines.join("\n");
  return {
    topicId: input.topic.id,
    tier: input.tier,
    text,
    contentHash: sha256(text),
    keywords,
    paperNumbers: papers.map((p) => p.paperNumber),
  };
}

/**
 * Batch helper: build every (topic × tier) chunk the topic supports, skipping
 * tier/topic combinations with no content.
 */
export function buildAllTopicChunks(
  refs: TopicChunkRefs,
  topics: TopicContextDto[],
): TopicChunk[] {
  const tiers: LevelTier[] = ["IGCSE", "AS", "A2"];
  const out: TopicChunk[] = [];
  for (const topic of topics) {
    const topicTiers = new Set(topic.levelTiers);
    for (const tier of tiers) {
      if (!topicTiers.has(tier)) continue;
      const chunk = buildTopicChunk({ ...refs, topic, tier });
      if (chunk) out.push(chunk);
    }
  }
  return out;
}
