/**
 * Pattern E — Cambridge syllabi with "Candidates should be able to:" tables
 * that don't match A/B/C/D structurally.
 *
 * Covers the three syllabi in Phase 3c's "E1" group:
 *
 *   0606 IGCSE Additional Mathematics
 *     - Flat: one-level topics "1 Functions", LRs numbered "1.1.", "1.2.", …
 *       with a trailing period. No subtopics.
 *   0478 IGCSE Computer Science
 *     - Three-level: topic "1 Data representation" → subtopic "1.1 Number
 *       systems" → numbered LRs "1", "2 (a)", "2 (b)", …
 *   9618 Cambridge International AS & A Level Computer Science
 *     - Three-level with AS/A2 split: "AS content" prelude introduces topics
 *       1–12, "A Level content" prelude introduces topics 13+. LRs are
 *       unnumbered — each row of the two-column "Candidates should be able
 *       to:" table is one LR, with the left column carrying the statement
 *       and the right column carrying notes.
 *
 * The parser selects an LR-detection strategy from the syllabus code rather
 * than trying to auto-detect: the three shapes are distinct enough that a
 * flexible catch-all would mis-count LRs on every run.
 */

import { commandWordOf } from "../commandWords";
import type { LevelTier } from "@shared/schema";
import type {
  ParsedSyllabus,
  ParsedTopic,
  ParsedSubtopic,
  ParsedRequirement,
} from "./types";
import { collapseWhitespace, isPageNoise, splitColumns } from "./shared";

const SECTION_START = /^\s*3\s+Subject content\s*$/;
const SECTION_END = /^\s*4\s+Details of the assessment\b/;

// "AS content" / "A Level content" section preludes in 9618.
const AS_BOUNDARY = /^\s*AS content\s*$/;
const A2_BOUNDARY = /^\s*A Level content\s*$/;

// Topic "  N    Title" — 1–2 digit number then 4+ spaces then capitalised
// title. The 4-space gap is what distinguishes a topic header from a
// numbered LR: 0478 LRs use exactly 3 spaces after the number ("1   Understand")
// while topics use 4+ ("1    Data representation"). 0606/9618 use even
// wider gaps (7+ spaces). Tightening the gap lets us detect topics even
// when we're already inside a "Candidates should be able to:" table —
// which 0606 never leaves because it has no subtopic layer.
const TOPIC_RX = /^\s{0,16}(\d{1,2})\s{4,}([A-Z][^\n]*?)(?:\s+continued)?\s*$/;

// Subtopic "  N.M  Title". Requires a capital letter start on the title so
// bullets or two-level LRs like "1.1. Understand…" aren't swallowed. The
// separator between number and title accepts any non-alphanumeric run so
// Cambridge's stray control bytes (pdftotext emits `\t\x07` on some rows,
// e.g. 0478 "4.2\t\x07Types of programming language…") still match.
const SUBTOPIC_RX = /^\s{0,16}(\d{1,2}\.\d{1,2})[^0-9A-Za-z]+([A-Z][^\n]*?)(?:\s+continued)?\s*$/;

// "Candidates should be able to:" — toggles the parser into table mode.
const LR_ANCHOR_RX = /^\s*Candidates should be able to:/;

// 0606-style numbered LR: "1.1.  Understand…" (N.M. with trailing period).
const LR_DOTTED_RX = /^\s{0,16}(\d{1,2}\.\d{1,2})\.\s+(.+)$/;

// 0478-style numbered LR: "1   Understand…" (1–2 digits, 2+ spaces, capital
// or parenthesised sub-letter).
const LR_NUMBERED_RX = /^\s{0,16}(\d{1,2})\s{2,}([A-Z(].*)$/;

// Command words that Cambridge uses to open a "left column" LR on 9618.
// We recognise a new LR when a left-column line starts with one of these
// followed by a space — the list intentionally mirrors the commandWords
// map plus a handful of start-verbs Cambridge uses exclusively in 9618.
const LR_START_VERBS = new Set([
  "analyse", "apply", "calculate", "compare", "construct", "deduce",
  "define", "demonstrate", "derive", "describe", "design", "determine",
  "develop", "discuss", "distinguish", "draw", "estimate", "evaluate",
  "examine", "explain", "explore", "identify", "illustrate", "infer",
  "interpret", "investigate", "justify", "know", "list", "measure",
  "outline", "perform", "predict", "present", "produce", "prove",
  "recall", "recognise", "recognize", "reflect", "select", "show",
  "sketch", "solve", "state", "suggest", "summarise", "summarize",
  "trace", "understand", "use", "verify", "write",
  // Cambridge 9618-specific / phrasal starters:
  "choose",
]);

interface WorkingSubtopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  requirements: ParsedRequirement[];
}

interface WorkingTopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  strandName?: string | null;
  subtopics: WorkingSubtopic[];
}

export function parsePatternE(syllabusCode: string, text: string): ParsedSyllabus {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  const contentLines = sliceSubjectContent(lines);

  const topicIndex = new Map<string, WorkingTopic>();
  const topicsOrder: WorkingTopic[] = [];

  // Tier tracking: defaults to the IGCSE/AS tier based on syllabus code,
  // then flips when we see "AS content" or "A Level content" (9618).
  const isIgcse = syllabusCode.startsWith("0");
  let currentTier: LevelTier = isIgcse ? "IGCSE" : "AS";

  let activeTopic: WorkingTopic | null = null;
  let activeSubtopic: WorkingSubtopic | null = null;
  // When true, we're inside a "Candidates should be able to:" block and
  // should interpret numbered N/N.M. lines as LRs rather than topics.
  let inLrTable = false;
  // Accumulator for the LR currently being built.
  let lrBuffer: { statement: string[]; notes: string[] } | null = null;

  const flushLr = () => {
    if (!lrBuffer || !activeSubtopic) {
      lrBuffer = null;
      return;
    }
    const statement = collapseWhitespace(lrBuffer.statement.join(" "));
    if (!statement) {
      lrBuffer = null;
      return;
    }
    const notes = collapseWhitespace(lrBuffer.notes.join(" "));
    activeSubtopic.requirements.push({
      statement,
      commandWord: commandWordOf(statement),
      notesAndExamples: notes || null,
    });
    lrBuffer = null;
  };

  const ensureSyntheticSubtopic = () => {
    if (!activeTopic) return null;
    if (activeSubtopic) return activeSubtopic;
    // 0606 has no subtopic layer — synthesise one so LRs can still attach.
    // Reuse the existing synthetic N.1 so requirements from a "continued"
    // page append to the same bucket instead of splitting across duplicates.
    const synthNumber = `${activeTopic.number}.1`;
    const existing = activeTopic.subtopics.find((s) => s.number === synthNumber);
    if (existing) {
      activeSubtopic = existing;
      return existing;
    }
    const synth: WorkingSubtopic = {
      number: synthNumber,
      title: activeTopic.title,
      levelTier: activeTopic.levelTier,
      requirements: [],
    };
    activeTopic.subtopics.push(synth);
    activeSubtopic = synth;
    return synth;
  };

  for (const raw of contentLines) {
    const trimmed = raw.trim();

    // Tier markers — toggle AS/A2 for 9618.
    if (!isIgcse && AS_BOUNDARY.test(trimmed)) {
      flushLr();
      currentTier = "AS";
      inLrTable = false;
      activeSubtopic = null;
      continue;
    }
    if (!isIgcse && A2_BOUNDARY.test(trimmed)) {
      flushLr();
      currentTier = "A2";
      inLrTable = false;
      activeSubtopic = null;
      continue;
    }

    if (!trimmed) {
      // Blank line: close the in-flight LR but keep table mode active so
      // the next numbered row or left-column paragraph still counts.
      flushLr();
      continue;
    }
    if (isPageNoise(trimmed)) continue;

    // "Candidates should be able to:" — enter table mode.
    if (LR_ANCHOR_RX.test(trimmed)) {
      flushLr();
      inLrTable = true;
      ensureSyntheticSubtopic();
      continue;
    }

    // Subtopic header: "1.1 Number systems" — always closes any active LR.
    const subMatch = SUBTOPIC_RX.exec(raw);
    if (subMatch && !LR_DOTTED_RX.test(raw)) {
      flushLr();
      const [, number, title] = subMatch;
      if (!activeTopic) {
        warnings.push(`Pattern E: subtopic ${number} before any topic — skipped`);
        continue;
      }
      activeSubtopic = activeTopic.subtopics.find((s) => s.number === number) ?? null;
      if (!activeSubtopic) {
        activeSubtopic = {
          number,
          title: collapseWhitespace(title),
          levelTier: activeTopic.levelTier,
          requirements: [],
        };
        activeTopic.subtopics.push(activeSubtopic);
      }
      inLrTable = false;
      continue;
    }

    // Topic header: "1    Data representation". TOPIC_RX's 4-space gap
    // guarantees a numbered LR ("1   Understand") cannot accidentally
    // match, so we can accept a topic even while inLrTable is true — this
    // is the path 0606 relies on since it has no subtopic layer.
    const topicMatch = TOPIC_RX.exec(raw);
    if (topicMatch) {
      flushLr();
      const [, number, title] = topicMatch;
      const isNewTopic = !topicIndex.has(number);
      if (isNewTopic) {
        const t: WorkingTopic = {
          number,
          title: collapseWhitespace(title),
          levelTier: currentTier,
          subtopics: [],
        };
        topicIndex.set(number, t);
        topicsOrder.push(t);
      }
      activeTopic = topicIndex.get(number)!;
      // A re-encounter of the same topic number is a "continued" banner —
      // keep inLrTable set so the following numbered LRs still count. Only
      // a fresh topic resets the table state.
      if (isNewTopic) {
        activeSubtopic = null;
        inLrTable = false;
      }
      continue;
    }

    // From here on we are inside a Candidates table and the line is an LR
    // or LR continuation. Route by syllabus-specific strategy.
    if (!inLrTable) continue;

    if (!activeSubtopic) ensureSyntheticSubtopic();
    if (!activeSubtopic) continue;

    // 0606: "1.1. Statement text            Notes text" starts a new LR.
    // Strip the numbered prefix first so splitColumns doesn't trip on the
    // fixed 4-space gap Cambridge inserts between the number and the
    // statement — we want to split on the gutter that separates statement
    // from notes, not on that prefix gap.
    const dotted = LR_DOTTED_RX.exec(raw);
    if (dotted) {
      flushLr();
      const parts = splitTrailingNotes(dotted[2]);
      lrBuffer = { statement: [parts.left], notes: parts.right ? [parts.right] : [] };
      continue;
    }

    // 0478: "1   Statement           Notes" starts a new LR. Same
    // strip-then-split approach.
    const numbered = LR_NUMBERED_RX.exec(raw);
    if (numbered) {
      flushLr();
      const parts = splitTrailingNotes(numbered[2]);
      lrBuffer = { statement: [parts.left], notes: parts.right ? [parts.right] : [] };
      continue;
    }

    // A continuation line may carry statement text in the left column,
    // notes text in the right column, or both. Split with splitColumns
    // first; when the line has no gutter but is heavily indented
    // (leading whitespace ≥ 45 chars) assume it's a right-column-only
    // continuation of the notes — otherwise short trailing fragments like
    // "Range gf ⊆ Range g" would be merged into the statement.
    const columns = splitColumns(raw);
    const leadingSpaces = raw.length - raw.trimStart().length;
    let left = "";
    let rightTrim = "";
    if (columns) {
      left = columns.left;
      rightTrim = columns.right.trim();
    } else if (leadingSpaces >= 45) {
      rightTrim = raw.trim();
    } else {
      left = raw.trimEnd();
    }
    const leftTrim = left.trim();

    // 9618: left column carries unnumbered LR statements, new LR begins
    // when the left column starts with a recognised verb.
    if (leftTrim) {
      const firstWord = leftTrim.split(/\s+/, 1)[0]?.toLowerCase().replace(/[.,:;()]+$/g, "") ?? "";
      const startsNewLr = LR_START_VERBS.has(firstWord) && /^[A-Z]/.test(leftTrim) && !lrBufferLooksUnfinished(lrBuffer);
      if (startsNewLr) {
        flushLr();
        lrBuffer = { statement: [leftTrim], notes: [] };
        if (rightTrim) lrBuffer.notes.push(rightTrim);
        continue;
      }
      // Continuation of the current LR's left column.
      if (lrBuffer) {
        lrBuffer.statement.push(leftTrim);
        if (rightTrim) lrBuffer.notes.push(rightTrim);
        continue;
      }
      // No LR in flight — start one using this line as the statement.
      lrBuffer = { statement: [leftTrim], notes: [] };
      if (rightTrim) lrBuffer.notes.push(rightTrim);
      continue;
    }

    // Right-column-only line (notes bullets on a continuation row).
    if (rightTrim && lrBuffer) {
      lrBuffer.notes.push(rightTrim);
    }
  }

  flushLr();

  const parsedTopics: ParsedTopic[] = topicsOrder.map((t): ParsedTopic => ({
    number: t.number,
    title: t.title,
    strandName: t.strandName ?? null,
    subtopics: t.subtopics.map((s): ParsedSubtopic => ({
      number: s.number,
      title: s.title,
      levelTier: s.levelTier,
      requirements: s.requirements,
    })),
  }));

  return {
    syllabusCode,
    pattern: "E",
    strands: [],
    papers: [],
    topics: parsedTopics,
    warnings,
  };
}

function sliceSubjectContent(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (SECTION_START.test(trimmed)) {
      inside = true;
      continue;
    }
    if (inside && SECTION_END.test(trimmed)) break;
    if (inside) out.push(raw);
  }
  return out;
}

// Heuristic for 9618: the in-flight LR looks unfinished when its last
// accumulated line ends mid-phrase (no terminal punctuation). New-LR
// detection skips the buffer reset in that case so continuations like
// "prefixes" (the tail of "between binary prefixes and decimal prefixes")
// don't prematurely close the previous LR.
/**
 * Split "statement<gutter>notes" where the gutter is 3+ spaces appearing
 * at least 15 characters into the string. The 15-char floor prevents the
 * fixed 3–7 space gap Cambridge places between an N.M.  / N  prefix and
 * the statement body from being mistaken for the notes-column gutter.
 */
function splitTrailingNotes(s: string): { left: string; right: string } {
  const match = s.match(/^(.{15,}?\S)(\s{3,})(\S.*)$/);
  if (!match) return { left: s.trim(), right: "" };
  return { left: match[1].trim(), right: match[3].trim() };
}

function lrBufferLooksUnfinished(buffer: { statement: string[] } | null): boolean {
  if (!buffer || buffer.statement.length === 0) return false;
  const last = buffer.statement[buffer.statement.length - 1].trim();
  if (!last) return false;
  return !/[.!?:]$/.test(last);
}
