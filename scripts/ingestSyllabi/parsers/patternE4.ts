/**
 * Pattern E4 — humanities syllabi whose subject content is organised around
 * themes, options, periods or prescribed skills rather than numbered LR
 * tables. Five syllabi fall into this group:
 *
 *   0520  IGCSE French                — Skills + Topic areas A–E
 *   9898  A Level French Lang & Lit   — Skills (B2/C1) + Topic areas 1–6
 *   0470  IGCSE History               — Core Option A/B + Depth studies A–E
 *   9489  A Level History             — European/American/International options
 *   9696  A Level Geography           — AS topics 1–6 (Papers 1/2) + A Level topics 7–10
 *
 * Each shape is different enough that a single generic walker would either
 * miss content or produce garbage. Instead we dispatch on the syllabus code
 * to a small per-syllabus parser that shares a common set of helpers
 * (bullet detection, topic/subtopic book-keeping, section slicing).
 */

import { commandWordOf } from "../commandWords";
import type { LevelTier } from "@shared/schema";
import type {
  ParsedSyllabus,
  ParsedTopic,
  ParsedSubtopic,
  ParsedRequirement,
} from "./types";
import { collapseWhitespace, isPageNoise } from "./shared";

export interface E4WorkingSubtopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  requirements: ParsedRequirement[];
}

export interface E4WorkingTopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  subtopics: E4WorkingSubtopic[];
}

export interface E4State {
  topicsOrder: E4WorkingTopic[];
  topicIndex: Map<string, E4WorkingTopic>;
  activeTopic: E4WorkingTopic | null;
  activeSubtopic: E4WorkingSubtopic | null;
  warnings: string[];
}

export function makeState(): E4State {
  return {
    topicsOrder: [],
    topicIndex: new Map(),
    activeTopic: null,
    activeSubtopic: null,
    warnings: [],
  };
}

export function ensureTopic(
  state: E4State,
  number: string,
  title: string,
  tier: LevelTier,
): E4WorkingTopic {
  const existing = state.topicIndex.get(number);
  if (existing) {
    state.activeTopic = existing;
    return existing;
  }
  const t: E4WorkingTopic = { number, title, levelTier: tier, subtopics: [] };
  state.topicIndex.set(number, t);
  state.topicsOrder.push(t);
  state.activeTopic = t;
  state.activeSubtopic = null;
  return t;
}

export function ensureSubtopic(
  state: E4State,
  number: string,
  title: string,
  tier: LevelTier,
): E4WorkingSubtopic | null {
  if (!state.activeTopic) return null;
  const existing = state.activeTopic.subtopics.find((s) => s.number === number);
  if (existing) {
    state.activeSubtopic = existing;
    return existing;
  }
  const s: E4WorkingSubtopic = { number, title, levelTier: tier, requirements: [] };
  state.activeTopic.subtopics.push(s);
  state.activeSubtopic = s;
  return s;
}

export function addRequirement(
  state: E4State,
  statement: string,
  notes?: string | null,
): void {
  if (!state.activeSubtopic) return;
  const clean = collapseWhitespace(statement);
  if (!clean) return;
  state.activeSubtopic.requirements.push({
    statement: clean,
    commandWord: commandWordOf(clean),
    notesAndExamples: notes ? collapseWhitespace(notes) : null,
  });
}

export function toParsedSyllabus(
  syllabusCode: string,
  state: E4State,
): ParsedSyllabus {
  const topics: ParsedTopic[] = state.topicsOrder.map((t): ParsedTopic => ({
    number: t.number,
    title: t.title,
    strandName: null,
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
    topics,
    warnings: state.warnings,
  };
}

/**
 * Slice lines between a start and end regex match. Used to carve
 * "3 Subject content" … "4 Details of the assessment" out of the PDF.
 */
export function sliceBetween(
  lines: string[],
  start: RegExp,
  end: RegExp,
): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!inside && start.test(trimmed)) {
      inside = true;
      continue;
    }
    if (inside && end.test(trimmed)) break;
    if (inside && !isPageNoise(trimmed)) out.push(raw);
  }
  return out;
}

/** A leading "• " marker on a line, possibly after indentation. */
const BULLET_RX = /^(\s*)•\s+(.*)$/;
/** A nested dash marker "–" (en-dash) on a line, after more indent. */
const NESTED_DASH_RX = /^(\s*)[–-]\s+(.*)$/;

export function matchBullet(raw: string): { indent: number; text: string } | null {
  const m = BULLET_RX.exec(raw);
  if (!m) return null;
  return { indent: m[1].length, text: m[2].trimEnd() };
}

export function matchDash(raw: string): { indent: number; text: string } | null {
  const m = NESTED_DASH_RX.exec(raw);
  if (!m) return null;
  return { indent: m[1].length, text: m[2].trimEnd() };
}

// ---------------------------------------------------------------------------
// Per-syllabus parsers. Each returns a complete ParsedSyllabus.
// ---------------------------------------------------------------------------

import { parse0520, parse9898 } from "./patternE4_french";
import { parse9696 } from "./patternE4_9696";
import { parse9489 } from "./patternE4_9489";
import { parse0470 } from "./patternE4_0470";

export function parsePatternE4(syllabusCode: string, text: string): ParsedSyllabus {
  switch (syllabusCode) {
    case "0520":
      return parse0520(text);
    case "9898":
      return parse9898(text);
    case "9696":
      return parse9696(text);
    case "9489":
      return parse9489(text);
    case "0470":
      return parse0470(text);
    // Additional syllabi wired in below as their parsers land.
    default:
      return {
        syllabusCode,
        pattern: "E",
        strands: [],
        papers: [],
        topics: [],
        warnings: [`Pattern E4: no parser implemented for ${syllabusCode} yet`],
      };
  }
}
