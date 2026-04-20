/**
 * 9489 Cambridge International AS & A Level History.
 *
 * The syllabus splits subject content across three papers:
 *
 *   Paper 1 and Paper 2 (AS Level)
 *     European option     → Topic 1 France, Topic 2 Germany, Topic 3 Russia
 *     American option     → Topic 4 Civil War, Topic 5 Gilded Age, Topic 6 Great Depression
 *     International option→ Topic 7 Imperialism, Topic 8 International relations,
 *                           Topic 9 Global Powers
 *   Paper 3 (A Level)
 *     Topic N: <title>    (historical interpretations — nine topics)
 *   Paper 4 (A Level)
 *     Topic N: <title>    (depth studies — nine topics)
 *
 * Topic numbers collide across papers, so we prefix them when emitting:
 *   "1"–"9"   for AS Paper 1/2 topics
 *   "P3-1"–"P3-9" for Paper 3 topics
 *   "P4-1"–"P4-9" for Paper 4 topics
 *
 * Paper 1/2 topics use "N.M Key question?" subtopics with nested bullet
 * content. Papers 3/4 are prose-heavy with fewer structural anchors; we
 * treat their "Topic N:" heads as topics and any top-level bullets under
 * them as requirements.
 */

import type { LevelTier } from "@shared/schema";
import type { ParsedSyllabus } from "./types";
import {
  addRequirement,
  ensureSubtopic,
  ensureTopic,
  makeState,
  matchBullet,
  matchDash,
  sliceBetween,
  toParsedSyllabus,
} from "./patternE4";
import { collapseWhitespace } from "./shared";

const SECTION_START = /^3\s+Subject content$/;
const SECTION_END = /^4\s+Details of the assessment\b/;

const PAPER_1_2_BANNER = /^Paper 1 and Paper 2$/;
const PAPER_3_BANNER = /^Paper 3$/;
const PAPER_4_BANNER = /^Paper 4$/;

// Option banner — records option name as grouping metadata (not persisted
// separately in the schema, but useful for title disambiguation later).
const OPTION_BANNER = /^(European|American|International) option:\s+(.+)$/;

// "N       Title" — the lead topic header for AS Paper 1/2 and Paper 4.
// Separator can be wide spaces, a tab, or a tab+bell-byte artefact from the
// pdftotext extraction (Topic 9 in Paper 1/2 and Paper 4 Topics 7–8 use it).
// The guard in the caller ensures we don't match "N.M" subtopic heads here.
const NUMBERED_TOPIC_HEAD = /^\s{0,16}(\d{1,2})[ \t\u00A0\x07]+([A-Z].+?)\s*$/;
// "N.M Key question?" — subtopic header. The question-mark terminator is
// typical but not required; we also accept non-question key questions.
// The separator may include a bell-byte artefact after the tab.
const AS_SUBTOPIC_HEAD = /^\s{0,16}(\d{1,2}\.\d{1,2})[\s\x07]+([A-Z].+?)(?:\s+continued)?\s*$/;

// "Topic N: Title" — used in Paper 3 (historical interpretations).
const PAPER_TOPIC_HEAD = /^\s*Topic\s+(\d{1,2}):\s*(.+?)\s*$/;

// Nested circle bullet "○" under a dashed sub-bullet.
const CIRCLE_RX = /^(\s*)○\s+(.*)$/;

type Mode = "pre" | "paper12" | "paper3" | "paper4";

export function parse9489(text: string): ParsedSyllabus {
  const state = makeState();
  const lines = sliceBetween(text.split(/\r?\n/), SECTION_START, SECTION_END);

  let mode: Mode = "pre";

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (PAPER_1_2_BANNER.test(trimmed)) {
      mode = "paper12";
      continue;
    }
    if (PAPER_3_BANNER.test(trimmed)) {
      mode = "paper3";
      state.activeTopic = null;
      state.activeSubtopic = null;
      continue;
    }
    if (PAPER_4_BANNER.test(trimmed)) {
      mode = "paper4";
      state.activeTopic = null;
      state.activeSubtopic = null;
      continue;
    }

    if (mode === "pre") continue;

    // Option banner — informational only; resets active scope so a fresh
    // topic in the next section gets its own state.
    if (mode === "paper12" && OPTION_BANNER.test(trimmed)) {
      continue;
    }

    if (mode === "paper12") {
      parseNumberedSection(state, raw, trimmed, "", "AS");
    } else if (mode === "paper3") {
      parsePaper3Line(state, raw);
    } else {
      parseNumberedSection(state, raw, trimmed, "P4-", "A2");
    }
  }

  return toParsedSyllabus("9489", state);
}

/**
 * Paper 1/2 and Paper 4 both use the same "N   Title" + "N.M Key question?"
 * skeleton with bullet + nested-dash content. They differ only in topic-number
 * prefix (empty for Paper 1/2, "P4-" for Paper 4) and level tier.
 */
function parseNumberedSection(
  state: ReturnType<typeof makeState>,
  raw: string,
  trimmed: string,
  prefix: string,
  tier: LevelTier,
): void {
  // Topic header "1   France, 1774–1814". Guard against "N.M" subtopic heads
  // (they start with digit-dot-digit and would otherwise match).
  if (!/^\d+\.\d+/.test(trimmed)) {
    const topic = NUMBERED_TOPIC_HEAD.exec(raw);
    if (topic) {
      const [, number, title] = topic;
      ensureTopic(state, `${prefix}${number}`, collapseWhitespace(title), tier);
      state.activeSubtopic = null;
      return;
    }
  }

  // Subtopic "1.1 Key question?"
  const sub = AS_SUBTOPIC_HEAD.exec(raw);
  if (sub) {
    const [, number, title] = sub;
    ensureSubtopic(state, `${prefix}${number}`, collapseWhitespace(title), tier);
    return;
  }

  // Top-level bullet.
  const bullet = matchBullet(raw);
  if (bullet && state.activeSubtopic) {
    addRequirement(state, bullet.text);
    return;
  }

  // Nested dash / circle — append to the last LR's notes.
  const dash = matchDash(raw);
  const circle = CIRCLE_RX.exec(raw);
  if ((dash || circle) && state.activeSubtopic?.requirements.length) {
    const text = dash ? dash.text : circle![2].trimEnd();
    const last = state.activeSubtopic.requirements.at(-1)!;
    const joined = last.notesAndExamples
      ? `${last.notesAndExamples}; ${text}`
      : text;
    last.notesAndExamples = collapseWhitespace(joined);
    return;
  }

  // Continuation of the last LR.
  if (state.activeSubtopic?.requirements.length) {
    const last = state.activeSubtopic.requirements.at(-1)!;
    if (last.notesAndExamples) {
      last.notesAndExamples = collapseWhitespace(`${last.notesAndExamples} ${trimmed}`);
    } else {
      last.statement = collapseWhitespace(`${last.statement} ${trimmed}`);
    }
  }
}

/**
 * Paper 3 — "Topic N: Title" prose section about historians' interpretations.
 * Each topic has a single synthetic subtopic carrying the prose bullets.
 */
function parsePaper3Line(
  state: ReturnType<typeof makeState>,
  raw: string,
): void {
  const topic = PAPER_TOPIC_HEAD.exec(raw);
  if (topic) {
    const [, number, title] = topic;
    const fullNumber = `P3-${number}`;
    ensureTopic(state, fullNumber, collapseWhitespace(title), "A2");
    ensureSubtopic(state, `${fullNumber}.1`, collapseWhitespace(title), "A2");
    return;
  }

  const bullet = matchBullet(raw);
  if (bullet && state.activeSubtopic) {
    addRequirement(state, bullet.text);
    return;
  }

  const dash = matchDash(raw);
  const circle = CIRCLE_RX.exec(raw);
  if ((dash || circle) && state.activeSubtopic?.requirements.length) {
    const text = dash ? dash.text : circle![2].trimEnd();
    const last = state.activeSubtopic.requirements.at(-1)!;
    const joined = last.notesAndExamples
      ? `${last.notesAndExamples}; ${text}`
      : text;
    last.notesAndExamples = collapseWhitespace(joined);
  }
}
