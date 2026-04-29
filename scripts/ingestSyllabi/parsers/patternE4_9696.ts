/**
 * 9696 Cambridge International AS & A Level Geography.
 *
 * Structure:
 *
 *   3 Subject content
 *     AS Level content           (tier = AS, covers Topics 1–6)
 *       Paper 1 / Paper 2        (prose banners only)
 *         Topic N Title          (topic)
 *           N.M  Section header  (grouping; not persisted as subtopic)
 *             N.M.K  Leaf title  (persisted as subtopic)
 *               • bullet         (learning requirement)
 *                 – nested dash  (notes/examples context for bullet)
 *     A Level content            (tier = A2, covers Topics 7–12)
 *       …same shape as AS section…
 *   4 Details of the assessment
 *
 * The schema has topic/subtopic/requirement only, so we flatten the
 * three-level numbering to subtopic = N.M.K. The intermediate N.M header
 * becomes the subtopic's description. Nested dashes collapse into the
 * bullet's notes.
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
} from "./patternE4_helpers";
import { collapseWhitespace } from "./shared";

const SECTION_START = /^3\s+Subject content$/;
const SECTION_END = /^4\s+Details of the assessment\b/;
const AS_BOUNDARY = /^AS Level content$/;
const A2_BOUNDARY = /^A Level content$/;

// "Topic N Title"
const TOPIC_HEAD = /^\s*Topic\s+(\d{1,2})\s+(.+?)\s*$/;
// "N.M   Section heading" (two-level, no trailing text with further numbering)
const N_DOT_M = /^\s{0,16}(\d{1,2}\.\d{1,2})\s{2,}(.+?)\s*$/;
// "N.M.K  Leaf heading"
const N_DOT_M_DOT_K = /^\s{0,16}(\d{1,2}\.\d{1,2}\.\d{1,2})\s+(.+?)\s*$/;

export function parse9696(text: string): ParsedSyllabus {
  const state = makeState();
  const lines = sliceBetween(text.split(/\r?\n/), SECTION_START, SECTION_END);

  let tier: LevelTier = "AS";
  // Tracks the most recent N.M header so we can populate the subtopic
  // description when we land on its leaf N.M.K rows.
  let currentSectionTitle: string | null = null;
  // Last bullet LR — nested dashes append to its notes.
  let lastBulletText: string | null = null;
  // Multi-line subtopic title continuation.
  let titleContinuationLines = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      lastBulletText = null;
      continue;
    }

    if (AS_BOUNDARY.test(trimmed)) {
      tier = "AS";
      continue;
    }
    if (A2_BOUNDARY.test(trimmed)) {
      tier = "A2";
      continue;
    }

    // Topic header.
    const topic = TOPIC_HEAD.exec(raw);
    if (topic) {
      const [, number, title] = topic;
      ensureTopic(state, number, collapseWhitespace(title), tier);
      state.activeSubtopic = null;
      currentSectionTitle = null;
      lastBulletText = null;
      titleContinuationLines = 0;
      continue;
    }

    // Leaf N.M.K subtopic header.
    const leaf = N_DOT_M_DOT_K.exec(raw);
    if (leaf) {
      const [, number, title] = leaf;
      const sub = ensureSubtopic(state, number, collapseWhitespace(title), tier);
      if (sub && currentSectionTitle && !sub.title.includes(currentSectionTitle)) {
        // Intentionally no-op: the section title is grouping metadata we
        // don't currently persist separately.
      }
      lastBulletText = null;
      titleContinuationLines = 1;
      continue;
    }

    // N.M grouping header (not persisted).
    const section = N_DOT_M.exec(raw);
    if (section) {
      currentSectionTitle = collapseWhitespace(section[2]);
      state.activeSubtopic = null;
      lastBulletText = null;
      titleContinuationLines = 0;
      continue;
    }

    // Top-level bullet under the current subtopic.
    const bullet = matchBullet(raw);
    if (bullet) {
      titleContinuationLines = 0;
      if (!state.activeSubtopic) continue;
      addRequirement(state, bullet.text);
      lastBulletText = bullet.text;
      continue;
    }

    // Nested dash row — append to the last bullet's notes.
    const dash = matchDash(raw);
    if (dash && state.activeSubtopic?.requirements.length) {
      const last = state.activeSubtopic.requirements.at(-1)!;
      const joined = last.notesAndExamples
        ? `${last.notesAndExamples}; ${dash.text}`
        : dash.text;
      last.notesAndExamples = collapseWhitespace(joined);
      continue;
    }

    // Otherwise: continuation of a subtopic title (rare — leaf titles wrap)
    // or continuation of the previous bullet/dash text.
    if (titleContinuationLines > 0 && state.activeSubtopic) {
      state.activeSubtopic.title = collapseWhitespace(
        `${state.activeSubtopic.title} ${trimmed}`,
      );
      titleContinuationLines = 0;
      continue;
    }
    if (state.activeSubtopic?.requirements.length) {
      const last = state.activeSubtopic.requirements.at(-1)!;
      if (last.notesAndExamples) {
        last.notesAndExamples = collapseWhitespace(`${last.notesAndExamples} ${trimmed}`);
      } else {
        last.statement = collapseWhitespace(`${last.statement} ${trimmed}`);
      }
    }
  }

  return toParsedSyllabus("9696", state);
}
