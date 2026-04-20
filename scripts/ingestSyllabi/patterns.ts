/**
 * Pattern classifier for Cambridge syllabus PDFs.
 *
 * The extraction spec (curriculum-docs/SYLLABUS_EXTRACTION_SPEC.md) identifies
 * four structural patterns:
 *
 *   A  — Sciences with disjoint AS/A2 topic blocks (9702, 9701, 9700)
 *   B  — Paper-keyed component topics (9709 Mathematics)
 *   C  — Shared theme with AS/A2 subtopic split (9708 Economics)
 *   D  — IGCSE Core/Extended two-column layout (0580, 0610, 0620, …)
 *
 * The classifier inspects the "Content overview" region of the extracted
 * text and returns the pattern. Pattern parsers live in Phase 3b.
 */

export type SyllabusPattern = "A" | "B" | "C" | "D" | "E" | "unclassified";

export interface ClassificationResult {
  pattern: SyllabusPattern;
  /** Human-readable reason, surfaced in ingestion logs for debugging. */
  reason: string;
}

const SIGNAL_PATTERN_B = [
  // 9709 declares its paper-keyed components explicitly in the overview.
  /Pure Mathematics components:\s*Paper 1: Pure Mathematics 1/i,
  /Paper 4: Mechanics\s+Paper 5: Probability/i,
];

const SIGNAL_PATTERN_A = [
  // The two section headers exist in every Pattern A syllabus but are
  // separated by many pages. We look for each one independently and count
  // them as Pattern A hits when both appear at least once.
  /^\s*AS Level subject content\s*$/im,
  /^\s*A Level subject content\s*$/im,
  // Distinctive phrasing: A-level candidates inherit the AS topics.
  /study the AS (?:Level )?topics and the/i,
  /AS Level learning outcomes is assumed knowledge/i,
];

const SIGNAL_PATTERN_C = [
  // Economics-style side-by-side "AS Level topics | A Level topics" table
  /AS Level topics\s+A Level topics/i,
  /students study topics 1\.\d+[–-]\d+\.\d+\./i,
];

// IGCSE Pattern C signals are count-based because the structural markers
// occur dozens of times in a real Pattern C syllabus but only a handful of
// times (e.g. in running prose or footers) in unrelated humanities syllabi.
// Thresholds were picked from the dry-run corpus: 0452 Accounting has 27
// "Candidates should have an understanding of" hits, 0455 Economics has
// 30+ `N.M.P` headings; 9696 Geography (a false positive under a boolean
// check) has 1 of each.
const IGCSE_PATTERN_C_BOILERPLATE = /Candidates should have an understanding of/gi;
const IGCSE_PATTERN_C_THREE_LEVEL = /^\s{0,16}\d{1,2}\.\d{1,2}\.\d{1,2}\s+\S/gm;
const IGCSE_PATTERN_C_MIN_HITS = 5;

const SIGNAL_PATTERN_D = [
  // IGCSE Core / Extended headers + "Candidates study" content overview.
  /Core\s+(?:assessment|subject content)/i,
  /Extended\s+(?:assessment|subject content)/i,
];

// Pattern E signal: "Candidates should be able to:" appears many times as
// the header of each two-column LR table (E1 — 0606, 0478, 9618). Non-E
// unclassified syllabi have at most a handful of occurrences. A threshold
// of 10 cleanly separates the two groups in the dry-run corpus:
// 0606=16, 0478=35, 9618=45 vs. every other unclassified ≤ 4.
const PATTERN_E1_ANCHOR = /Candidates should be able to:/g;
const PATTERN_E1_MIN_HITS = 10;

/**
 * Classify the syllabus. `topBand` is used only as a weak prior — when the
 * textual signals disagree with the prior we trust the signals but flag the
 * reason in the result.
 */
export function classifySyllabus(
  extractedText: string,
  topBand: "IGCSE" | "A_Level",
  syllabusCode: string,
): ClassificationResult {
  // Pattern E4: humanities syllabi (themes / options / depth studies / skills
  // bands) that would otherwise fall through to "unclassified". There is no
  // reliable textual anchor that separates them from deferred Literature /
  // English Language syllabi, so the classifier uses an explicit code
  // whitelist. Each entry has a bespoke parser in parsers/patternE4.ts.
  const PATTERN_E4_CODES = new Set(["0470", "9489", "9696", "0520", "9898"]);
  if (PATTERN_E4_CODES.has(syllabusCode)) {
    return { pattern: "E", reason: `Pattern E4 syllabus code (${syllabusCode})` };
  }

  const hits: Record<SyllabusPattern, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, unclassified: 0 };
  for (const rx of SIGNAL_PATTERN_A) if (rx.test(extractedText)) hits.A++;
  for (const rx of SIGNAL_PATTERN_B) if (rx.test(extractedText)) hits.B++;
  for (const rx of SIGNAL_PATTERN_C) if (rx.test(extractedText)) hits.C++;
  for (const rx of SIGNAL_PATTERN_D) if (rx.test(extractedText)) hits.D++;

  // 9709 always wins as Pattern B — it has both "Pure Mathematics components"
  // headers and weaker Pattern A/C signals, but the paper-keyed structure
  // overrides them.
  if (hits.B > 0) {
    return { pattern: "B", reason: "paper-keyed component headers present" };
  }

  // For A Level, disambiguate A vs C by counting hits.
  if (topBand === "A_Level") {
    if (hits.C > hits.A) {
      return { pattern: "C", reason: `Pattern C signals (${hits.C}) dominated Pattern A (${hits.A})` };
    }
    if (hits.A > 0) {
      return { pattern: "A", reason: `Pattern A signals (${hits.A} hits)` };
    }
    // Pattern E1: A Level Computer Science (9618) has dozens of
    // "Candidates should be able to:" table headers but no AS/A2 subject-
    // content anchors and no three-level numbering.
    const e1Hits = countMatches(extractedText, PATTERN_E1_ANCHOR);
    if (e1Hits >= PATTERN_E1_MIN_HITS) {
      return { pattern: "E", reason: `Pattern E anchor hits (${e1Hits})` };
    }
    // Fallback — non-science A-level syllabi (English Literature 9695,
    // History 9489, etc.) may not match either. Leave as unclassified; the
    // orchestrator will log and skip them at Phase 3c rather than silently
    // mis-ingesting.
    return { pattern: "unclassified", reason: `no A/B/C/E signals for ${syllabusCode}` };
  }

  // IGCSE
  if (hits.D > 0) {
    return { pattern: "D", reason: `IGCSE Core/Extended signals (${hits.D} hits)` };
  }
  const boilerplateHits = countMatches(extractedText, IGCSE_PATTERN_C_BOILERPLATE);
  const threeLevelHits = countMatches(extractedText, IGCSE_PATTERN_C_THREE_LEVEL);
  if (boilerplateHits >= IGCSE_PATTERN_C_MIN_HITS || threeLevelHits >= IGCSE_PATTERN_C_MIN_HITS) {
    return {
      pattern: "C",
      reason: `IGCSE Pattern C signals (boilerplate=${boilerplateHits}, three-level=${threeLevelHits})`,
    };
  }
  // Pattern E1: IGCSE Additional Maths (0606) and IGCSE Computer Science
  // (0478) use the same "Candidates should be able to:" two-column table
  // layout as A-level E1 syllabi but lack the Pattern D Core/Extended split.
  const e1Hits = countMatches(extractedText, PATTERN_E1_ANCHOR);
  if (e1Hits >= PATTERN_E1_MIN_HITS) {
    return { pattern: "E", reason: `Pattern E anchor hits (${e1Hits})` };
  }
  // Non-science IGCSE syllabi (Literature 0475, History 0470, etc.) may not
  // expose the Core/Extended split in the same way. Flag for Phase 3c.
  return { pattern: "unclassified", reason: `no IGCSE Core/Extended/E signals for ${syllabusCode}` };
}

function countMatches(text: string, rx: RegExp): number {
  // Both source regexes carry the global flag so matchAll is safe.
  let count = 0;
  for (const _ of text.matchAll(rx)) count++;
  return count;
}
