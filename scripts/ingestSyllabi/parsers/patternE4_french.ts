/**
 * Pattern E4 parsers for the French syllabi.
 *
 *   0520  Cambridge IGCSE French
 *   9898  Cambridge International A Level French Language & Literature
 *
 * Both are skills+themes syllabi with a common shape:
 *
 *   3 Subject content
 *     Skills
 *       Listening / Reading / Speaking / Writing              (0520)
 *       Reading / Writing / Literature, each with B2 / C1     (9898)
 *         • <one skill statement>
 *         • <one skill statement>
 *     Topic areas
 *       A / B / C / D / E      (0520)   or   1 / 2 / … / 6     (9898)
 *         <theme header>
 *         • <sub-topic or example>
 *   4 Details of the assessment
 */

import type { LevelTier } from "@shared/schema";
import type { ParsedSyllabus } from "./types";
import {
  addRequirement,
  ensureSubtopic,
  ensureTopic,
  makeState,
  matchBullet,
  sliceBetween,
  toParsedSyllabus,
} from "./patternE4_helpers";
import { collapseWhitespace } from "./shared";

const SECTION_START = /^3\s+Subject content$/;
const SECTION_END = /^4\s+Details of the assessment\b/;

// Section banners inside the subject content block.
const SKILLS_BANNER = /^Skills$/;
const TOPIC_AREAS_BANNER_0520 = /^Topic areas$/;
const A_LEVEL_TOPICS_BANNER_9898 = /^A Level topics$/;

// Skills subsections we treat as topics in both 0520 and 9898.
const SKILL_0520 = new Set(["Listening", "Reading", "Speaking", "Writing"]);
const SKILL_9898 = new Set(["Reading", "Writing", "Literature"]);

// 0520 topic-area row: "A  Everyday activities  •  Time expressions …"
// The row header line starts with a single-letter code in column 1, then the
// area title. Subsequent lines belong to the same area until the next letter.
const AREA_HEAD_0520 = /^\s*([A-E])\s{2,}([A-Z].*?)\s{2,}•\s+(.*)$/;
const AREA_HEAD_SIMPLE_0520 = /^\s*([A-E])\s{2,}([A-Z].*?)\s*$/;

// 9898 "For example:" line precedes a run of sub-bullets under a theme header.
const FOR_EXAMPLE = /^\s*For example:\s*$/;

/**
 * 0520 IGCSE French parser.
 */
export function parse0520(text: string): ParsedSyllabus {
  const state = makeState();
  const tier: LevelTier = "IGCSE";
  const lines = sliceBetween(text.split(/\r?\n/), SECTION_START, SECTION_END);

  type Mode = "pre" | "skills" | "topicAreas";
  let mode: Mode = "pre";
  let currentAreaCode: string | null = null;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Mode transitions.
    if (SKILLS_BANNER.test(trimmed)) {
      mode = "skills";
      state.activeTopic = null;
      state.activeSubtopic = null;
      continue;
    }
    if (TOPIC_AREAS_BANNER_0520.test(trimmed)) {
      mode = "topicAreas";
      state.activeTopic = null;
      state.activeSubtopic = null;
      currentAreaCode = null;
      continue;
    }

    if (mode === "skills") {
      // Sub-skill header ("Listening", "Reading", …).
      if (SKILL_0520.has(trimmed)) {
        const skill = trimmed;
        const number = `S-${skill}`;
        ensureTopic(state, number, skill, tier);
        ensureSubtopic(state, `${number}.1`, skill, tier);
        continue;
      }
      // Bullet = one skill statement.
      const b = matchBullet(raw);
      if (b) {
        addRequirement(state, b.text);
      } else if (state.activeSubtopic && state.activeSubtopic.requirements.length) {
        // Continuation of the previous bullet.
        const last = state.activeSubtopic.requirements.at(-1)!;
        last.statement = collapseWhitespace(`${last.statement} ${trimmed}`);
      }
      continue;
    }

    if (mode === "topicAreas") {
      // Row that mixes area header and first bullet: "A  Everyday activities  •  ..."
      const headBullet = AREA_HEAD_0520.exec(raw);
      if (headBullet) {
        const [, code, title, bulletText] = headBullet;
        currentAreaCode = code;
        ensureTopic(state, code, collapseWhitespace(title), tier);
        ensureSubtopic(state, `${code}.1`, collapseWhitespace(title), tier);
        addRequirement(state, bulletText);
        continue;
      }
      // Area header on its own line.
      const head = AREA_HEAD_SIMPLE_0520.exec(raw);
      if (head) {
        const [, code, title] = head;
        currentAreaCode = code;
        ensureTopic(state, code, collapseWhitespace(title), tier);
        ensureSubtopic(state, `${code}.1`, collapseWhitespace(title), tier);
        continue;
      }
      // Bullet row — belongs to the active area.
      const b = matchBullet(raw);
      if (b && currentAreaCode && state.activeSubtopic) {
        addRequirement(state, b.text);
        continue;
      }
      // Continuation of the last bullet.
      if (state.activeSubtopic && state.activeSubtopic.requirements.length) {
        const last = state.activeSubtopic.requirements.at(-1)!;
        last.statement = collapseWhitespace(`${last.statement} ${trimmed}`);
      }
    }
  }

  return toParsedSyllabus("0520", state);
}

// ---------------------------------------------------------------------------
// 9898 A Level French Language & Literature
//
// Structure:
//   Skills
//     Reading / Writing / Literature
//       │ B2 bullet                │ C1 bullet   (two columns, parallel rows)
//   A Level topics
//     │ 1 Culture  │ Entertainment        (2-column outer table:
//     │            │ For example:          left = topic num+name,
//     │            │ • bullets              right = theme + bullets)
//     │            │ Identity and culture
//     │            │ • bullets
//
// Both sections are 2-column tables. We detect the column boundary from the
// section's header row ("Skills demonstrated at B2 level … Skills
// demonstrated at C1 level" or "Topic areas … Sub-topics and examples")
// then slice every subsequent row at that position.
// ---------------------------------------------------------------------------

const SKILLS_SUB_9898 = new Set(["Reading", "Writing", "Literature"]);
const B2_C1_HEADER = /^(\s*Skills demonstrated at B2 level\s+)Skills demonstrated at C1 level\s*$/;
const TOPIC_TABLE_HEADER_9898 = /^(\s*Topic areas\s+)Sub-topics and examples\s*$/;

// 9898 topic header sits in the left column as "N Title". pdftotext emits
// some rows with a U+2002 en-space + \x07 bell between the number and the
// title, so we accept any non-alphanumeric run as the separator (mirrors
// the E1 subtopic regex).
const LEFT_TOPIC_HEAD_9898 = /^\s*(\d{1,2})[^0-9A-Za-z]+([A-Z].*?)\s*$/;
// The right-column "Subject content" string appears at the bottom of each
// page as part of the running footer — we drop it so it doesn't register
// as a theme header.
const SUBJECT_CONTENT_FOOTER = /^Subject content\s*$/;

function sliceAt(line: string, col: number): { left: string; right: string } {
  if (line.length <= col) return { left: line.trimEnd(), right: "" };
  return { left: line.slice(0, col).trimEnd(), right: line.slice(col) };
}

export function parse9898(text: string): ParsedSyllabus {
  const state = makeState();
  const lines = sliceBetween(text.split(/\r?\n/), SECTION_START, SECTION_END);

  type Mode = "pre" | "skills" | "topics";
  let mode: Mode = "pre";
  let activeSkill: string | null = null;
  let c1Col = -1;      // column index where the C1 column starts (skills section)
  let topicCol = -1;   // column index where the Sub-topics column starts (topics section)
  // Topic titles in 9898 wrap across two rows ("2 Health and" on row 1,
  // "well-being" on row 2). We allow exactly one extra left-column line to
  // append to the topic title after a topic header, regardless of what the
  // right column of the header row contained.
  let titleContinuationRows = 0;

  const setActiveSubByNumber = (num: string) => {
    if (!state.activeTopic) return;
    state.activeSubtopic = state.activeTopic.subtopics.find((s) => s.number === num) ?? null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (SKILLS_BANNER.test(trimmed)) {
      mode = "skills";
      activeSkill = null;
      c1Col = -1;
      continue;
    }
    if (A_LEVEL_TOPICS_BANNER_9898.test(trimmed)) {
      mode = "topics";
      state.activeTopic = null;
      state.activeSubtopic = null;
      topicCol = -1;
      continue;
    }

    if (mode === "skills") {
      // Skill sub-heading (Reading / Writing / Literature).
      if (SKILLS_SUB_9898.has(trimmed)) {
        activeSkill = trimmed;
        const number = `S-${trimmed}`;
        ensureTopic(state, number, trimmed, "AS");
        ensureSubtopic(state, `${number}.B2`, `${trimmed} (B2)`, "AS");
        ensureSubtopic(state, `${number}.C1`, `${trimmed} (C1)`, "A2");
        c1Col = -1;
        continue;
      }
      // B2/C1 table header fixes the column boundary for the rows below.
      const header = B2_C1_HEADER.exec(raw);
      if (header) {
        c1Col = header[1].length;
        continue;
      }
      if (!activeSkill || c1Col <= 0) continue;

      const baseNum = `S-${activeSkill}`;
      const { left, right } = sliceAt(raw, c1Col);

      // A bullet on the left starts a new B2 LR; a bullet on the right
      // starts a new C1 LR. Continuation lines append to the last LR of
      // their respective column.
      const leftBullet = matchBullet(left);
      const rightBullet = matchBullet(right);

      if (leftBullet) {
        setActiveSubByNumber(`${baseNum}.B2`);
        addRequirement(state, leftBullet.text);
      } else if (left.trim()) {
        const sub = state.activeTopic?.subtopics.find((s) => s.number === `${baseNum}.B2`);
        const last = sub?.requirements.at(-1);
        if (last) last.statement = collapseWhitespace(`${last.statement} ${left.trim()}`);
      }
      if (rightBullet) {
        setActiveSubByNumber(`${baseNum}.C1`);
        addRequirement(state, rightBullet.text);
      } else if (right.trim()) {
        const sub = state.activeTopic?.subtopics.find((s) => s.number === `${baseNum}.C1`);
        const last = sub?.requirements.at(-1);
        if (last) last.statement = collapseWhitespace(`${last.statement} ${right.trim()}`);
      }
      continue;
    }

    if (mode === "topics") {
      // Every page of the topics section opens with a fresh
      // "Topic areas   Sub-topics and examples" header — use it to lock in
      // the column boundary. It can shift by a column or two per page.
      const header = TOPIC_TABLE_HEADER_9898.exec(raw);
      if (header) {
        topicCol = header[1].length;
        continue;
      }
      if (topicCol <= 0) continue;

      const { left, right } = sliceAt(raw, topicCol);

      // Left column: "N Title" — a new topic.
      const topicHead = LEFT_TOPIC_HEAD_9898.exec(left);
      if (topicHead) {
        const [, number, title] = topicHead;
        ensureTopic(state, number, collapseWhitespace(title), "A2");
        state.activeSubtopic = null;
        titleContinuationRows = 1;
      } else if (
        left.trim() &&
        titleContinuationRows > 0 &&
        state.activeTopic
      ) {
        // Topic title wraps across two rows ("2 Health and" / "well-being",
        // "5 Our responsibility" / "for the planet"). Append the second
        // line to the topic title.
        state.activeTopic.title = collapseWhitespace(
          `${state.activeTopic.title} ${left.trim()}`,
        );
        titleContinuationRows = 0;
      } else if (titleContinuationRows > 0 && !topicHead) {
        // Exhaust the continuation window after the first non-header row
        // regardless of whether we actually appended.
        titleContinuationRows--;
      }

      if (!state.activeTopic) continue;

      const rightTrim = right.trim();
      if (!rightTrim) continue;
      if (SUBJECT_CONTENT_FOOTER.test(rightTrim)) continue;
      if (FOR_EXAMPLE.test(rightTrim)) continue;

      // Right column: theme header or bullet or continuation.
      const rBullet = matchBullet(right);
      if (rBullet) {
        if (!state.activeSubtopic) {
          // Loose bullet before a theme header — create N.1 bucket.
          const subNum = `${state.activeTopic.number}.${state.activeTopic.subtopics.length + 1}`;
          ensureSubtopic(state, subNum, state.activeTopic.title, "A2");
        }
        addRequirement(state, rBullet.text);
        continue;
      }

      // Non-bullet, capitalised → new theme / subtopic header.
      if (/^[A-Z]/.test(rightTrim) && rightTrim.length < 80 && !/[.!?]$/.test(rightTrim)) {
        const subNum = `${state.activeTopic.number}.${state.activeTopic.subtopics.length + 1}`;
        ensureSubtopic(state, subNum, rightTrim, "A2");
        continue;
      }

      // Continuation of the last LR in the active subtopic.
      if (state.activeSubtopic?.requirements.length) {
        const last = state.activeSubtopic.requirements.at(-1)!;
        last.statement = collapseWhitespace(`${last.statement} ${rightTrim}`);
      }
    }
  }

  return toParsedSyllabus("9898", state);
}
