/**
 * Phase 7 — Noise stripper for syllabus PDF text.
 *
 * Cambridge (and most exam boards) emit a lot of boilerplate in their syllabus
 * PDFs that isn't relevant to teaching scope: registration instructions,
 * branding, running page headers/footers, copyright notices, grading-scale
 * explanations, etc. The Phase 3 parsers already ignored most of this via
 * pattern anchors, but when we ingest a new syllabus (or re-extract reference
 * text for Layer 2) we want one deterministic pre-clean pass first so that
 *
 *   - embedding chunks don't carry junk tokens that hurt semantic similarity
 *   - keyword extraction isn't polluted by words like "endorsed" or
 *     "registered trademark"
 *   - downstream pattern parsers get a tighter input to work on
 *
 * This module is deliberately conservative: it only removes lines that match
 * well-known boilerplate patterns, never whole sections. If a filter starts
 * eating real content, add a more specific regex rather than broadening.
 *
 * Pure string → string. Safe to call repeatedly (idempotent).
 */

export interface StripSyllabusNoiseOptions {
  /** If true, also collapse 3+ blank lines to 2. Defaults to true. */
  collapseBlankRuns?: boolean;
  /** Extra line-level regexes to drop (OR-ed with defaults). */
  extraDropPatterns?: RegExp[];
}

// Line-level matchers. Each regex tests a trimmed line; if any matches, the
// line is dropped. Order doesn't matter — first hit wins.
const DEFAULT_DROP_PATTERNS: RegExp[] = [
  // Running page-number markers: "Page 12", "Page 12 of 48", "12", "12/48"
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^\d{1,3}$/,
  /^\d{1,3}\s*\/\s*\d{1,3}$/,
  // Cambridge running header: "Cambridge IGCSE Mathematics 0580 syllabus for 2025, 2026 and 2027."
  /^cambridge\s+(igcse|international|o\s*level|as\s*&\s*a\s*level|a\s*level|international\s*as\s*&\s*a\s*level)\b.*syllabus\b.*\d{4}/i,
  // Copyright / trademark
  /^©\s*ucles/i,
  /^copyright\s*©/i,
  /^®\s*igcse/i,
  /^igcse.{0,5}is\s+a\s+registered\s+trademark/i,
  // Back-of-book admin blocks
  /^cambridge\s+assessment\s+international\s+education\s+is\s+part\s+of/i,
  /^the\s+cambridge\s+.{0,40}\s+series/i,
  /^to\s+find\s+out\s+more\s+(about|please)/i,
  /^for\s+further\s+information\s*(please)?\s*(contact|visit)/i,
  // Registration / administration pages
  /^how\s+to\s+register\s+candidates$/i,
  /^registration\s+arrangements$/i,
  /^making\s+entries$/i,
  /^administrative\s+guidance$/i,
  // Policy / versioning boilerplate often repeated
  /^this\s+syllabus\s+is\s+(approved|regulated)\s+(for\s+use\s+)?in/i,
  /^version\s+\d+(\.\d+)?$/i,
  /^(printed|published)\s+in\s+[a-z\s]+$/i,
  // Blank shell lines that just carry bullet glyphs
  /^[\s•·\-]+$/,
];

// Full-line keyword-only drops for obvious section headers that contain no
// teaching content. Match the trimmed, lowercased line exactly.
const DROP_EXACT_LINES = new Set([
  "contents",
  "introduction",
  "back cover",
  "front cover",
  "this page is intentionally blank",
  "blank page",
  "cambridge international",
  "contact us",
  "get in touch",
  "safeguarding",
]);

export function stripSyllabusNoise(
  raw: string,
  opts: StripSyllabusNoiseOptions = {},
): string {
  const collapseBlankRuns = opts.collapseBlankRuns ?? true;
  const patterns = opts.extraDropPatterns
    ? [...DEFAULT_DROP_PATTERNS, ...opts.extraDropPatterns]
    : DEFAULT_DROP_PATTERNS;

  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      kept.push("");
      continue;
    }
    const exactKey = trimmed.toLowerCase();
    if (DROP_EXACT_LINES.has(exactKey)) continue;
    if (patterns.some((re) => re.test(trimmed))) continue;
    kept.push(line);
  }

  let result = kept.join("\n");
  if (collapseBlankRuns) {
    result = result.replace(/\n{3,}/g, "\n\n");
  }
  // Trim leading/trailing whitespace so the output is canonical.
  return result.replace(/^\s+|\s+$/g, "");
}

/**
 * Smaller helper: strip noise *and* return per-line metadata about which lines
 * survived — handy if a downstream parser needs to preserve source-page
 * tracking. Kept separate from the main API to keep the common case simple.
 */
export function stripSyllabusNoiseDetailed(
  raw: string,
  opts: StripSyllabusNoiseOptions = {},
): { cleaned: string; droppedCount: number; keptCount: number } {
  const beforeLines = raw.split(/\r?\n/).length;
  const cleaned = stripSyllabusNoise(raw, opts);
  const afterLines = cleaned.split(/\r?\n/).length;
  return {
    cleaned,
    droppedCount: Math.max(0, beforeLines - afterLines),
    keptCount: afterLines,
  };
}
