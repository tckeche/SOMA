/**
 * Pattern A parser — Cambridge A Level sciences with disjoint AS/A2 blocks.
 *
 * Applies to 9700 Biology, 9701 Chemistry, 9702 Physics and 9705 Design &
 * Technology. The layout is:
 *
 *     AS Level subject content
 *       1    Physical quantities and units
 *       1.1  Physical quantities
 *
 *       Candidates should be able to:
 *       1.   understand that …
 *       2.   make reasonable estimates …
 *
 *       1.2  SI units
 *       …
 *
 *     A Level subject content
 *       12   Motion in a circle
 *       12.1 Kinematics of uniform circular motion
 *       …
 *
 * Subtopics inherit the parent section's level tier. Topic numbers are
 * integers; subtopic numbers are "N.M".
 *
 * 9705 Design & Technology skips the N.M level entirely — its topics roll
 * straight into "Content" blocks of `•` bullets. We detect that sub-variant
 * by the presence of `•` bullets under an active topic with no `N.M` subtopic
 * open, synthesise a "N.1 Content" subtopic, and harvest each `•` bullet as
 * an LR (sub-bullets "–" fold into the parent).
 */

import { commandWordOf, COMMAND_WORD_COMPETENCY_MAP } from "../commandWords";
import type { LevelTier } from "@shared/schema";
import type { ParsedSyllabus, ParsedTopic, ParsedSubtopic, ParsedRequirement } from "./types";
import { collapseWhitespace, isContinuationBanner, isPageNoise } from "./shared";

const SECTION_AS = /^\s*AS Level subject content\s*$/i;
const SECTION_A = /^\s*A Level subject content\s*$/i;
const SECTION_PRACTICAL = /^\s*Practical (?:skills|assessment) subject content\s*$/i;
const END_OF_CONTENT = /^\s*(?:4\s+Details of the assessment|Command words|Practical skills|Appendix)\b/i;

// Topic header: "1    Physical quantities and units". Cambridge's layout
// usually leaves ≥3 spaces between the number and title, but 9700 Biology's
// A-Level block compresses two-digit topics to a single space ("10 Infectious
// diseases"). pdftotext occasionally compresses the gap into a period (9702
// Physics emits "7.Waves"). The `[A-Z]` anchor and the command-word filter
// below weed out LR bullets that share the skeleton ("1    describe …" —
// always lowercase first word).
const TOPIC_RX = /^\s{0,16}(\d{1,2})(?:\s+|\.\s*)([A-Z][^\n]*?)\s*$/;

// Subtopic header: "1.1 Physical quantities". Allow an optional trailing
// word-block with numeric modifiers ("1.2 SI units").
const SUBTOPIC_RX = /^\s{0,14}(\d{1,2}\.\d{1,2})\s+([A-Z][^\n]*?)\s*$/;

// Requirement bullet — two Cambridge variants share the format:
//   "1.understand …", "2.   express …"  (9702 Physics style: number-dot)
//   "1     understand …", "2     identify …"  (9700 Biology / 9701 Chemistry: number-space)
// The leading whitespace is generous so right-column bullets in the
// two-column sciences layout are caught too.
const REQUIREMENT_RX = /^\s{0,60}(\d{1,2})(?:\.\s*|\s{3,})([A-Za-z].*?)\s*$/;

// 9705 Design & Technology bullet styles. The top-level `•` marks a new LR,
// the `–` sub-bullet folds into the active LR as a comma-joined clause.
const DT_BULLET_RX = /^\s{0,20}•\s+(.*)$/;
const DT_SUB_BULLET_RX = /^\s{0,28}–\s+(.*)$/;

// Deep-indented topic header: 9701 Chemistry prints "13 An introduction to
// AS Level organic chemistry" inside a functional-group table whose pdftotext
// output has 40+ leading spaces. The normal TOPIC_RX caps at 16 so these get
// missed; a post-pass recovers the title when the parser synthesised a
// placeholder because only `N.M` subtopics were seen.
const DEEP_TOPIC_RX = /^\s+(\d{1,2})\s{2,}([A-Z][^\n]*?)\s*$/;

// Not anchored to start-of-line: Biology 9700 renders the "Candidates should
// be able to:" marker in the right column of a two-column table, so the line
// begins with subtopic text and the marker appears after 40+ spaces.
const CANDIDATES_HEADER = /Candidates? (?:should be able to|for (?:Cambridge )?International .* should study|will be able to)/i;
const STRAND_HEADER = /^\s{0,14}(Physical chemistry|Inorganic chemistry|Organic chemistry|Physical Chemistry|Inorganic Chemistry|Organic Chemistry)\s*$/;

interface WorkingSubtopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  requirements: ParsedRequirement[];
}

interface WorkingTopic {
  number: string;
  title: string;
  strandName: string | null;
  subtopics: WorkingSubtopic[];
}

interface Section {
  tier: LevelTier;
  lines: string[];
}

export function parsePatternA(syllabusCode: string, text: string): ParsedSyllabus {
  const warnings: string[] = [];
  const sections = splitPatternASections(text);
  if (!sections.length) {
    warnings.push(`Pattern A: no "AS Level subject content" / "A Level subject content" markers found`);
    return emptyParsed(syllabusCode, warnings);
  }

  const topics: ParsedTopic[] = [];
  const topicIndex = new Map<string, WorkingTopic>();
  let currentStrand: string | null = null;

  for (const section of sections) {
    let activeTopic: WorkingTopic | null = null;
    let activeSubtopic: WorkingSubtopic | null = null;
    let inCandidatesBlock = false;
    let bulletBuffer: { bullet: number; lines: string[] } | null = null;
    // 9705 Design & Technology harvest: when the active topic has no N.M
    // subtopic and a `•` bullet is seen, we synthesise a "N.1 Content"
    // subtopic and capture each bullet as an LR. Sub-bullets fold into the
    // parent statement.
    let dtBulletBuffer: { lines: string[] } | null = null;

    const flushBullet = () => {
      if (!bulletBuffer || !activeSubtopic) {
        bulletBuffer = null;
        return;
      }
      const statement = collapseWhitespace(bulletBuffer.lines.join(" "));
      if (statement) {
        activeSubtopic.requirements.push({
          statement,
          commandWord: commandWordOf(statement),
        });
      }
      bulletBuffer = null;
    };

    const flushDtBullet = () => {
      if (!dtBulletBuffer || !activeSubtopic) {
        dtBulletBuffer = null;
        return;
      }
      const statement = collapseWhitespace(dtBulletBuffer.lines.join(" "));
      if (statement) {
        activeSubtopic.requirements.push({
          statement,
          commandWord: commandWordOf(statement),
        });
      }
      dtBulletBuffer = null;
    };

    const ensureDtSubtopic = () => {
      if (!activeTopic) return null;
      if (activeSubtopic && activeSubtopic.number.startsWith(`${activeTopic.number}.`)) {
        return activeSubtopic;
      }
      const number = `${activeTopic.number}.1`;
      activeSubtopic = activeTopic.subtopics.find((s) => s.number === number) ?? null;
      if (!activeSubtopic) {
        activeSubtopic = {
          number,
          title: "Content",
          levelTier: section.tier,
          requirements: [],
        };
        activeTopic.subtopics.push(activeSubtopic);
      }
      return activeSubtopic;
    };

    for (const raw of section.lines) {
      const trimmed = raw.trim();
      if (!trimmed) {
        // blank line ends the current bullet but stays inside the current block
        flushBullet();
        flushDtBullet();
        continue;
      }
      if (isPageNoise(trimmed)) continue;

      if (STRAND_HEADER.test(trimmed)) {
        currentStrand = trimmed;
        continue;
      }

      if (isContinuationBanner(trimmed) && !SUBTOPIC_RX.test(trimmed) && !REQUIREMENT_RX.test(trimmed)) {
        // "1    Kinematics continued" — do not create a new topic, just reuse
        // the active one (or rebuild it below when its subtopic re-appears).
        continue;
      }

      const topicMatch = TOPIC_RX.exec(raw);
      const subtopicMatch = SUBTOPIC_RX.exec(raw);

      // Disambiguate topic-vs-LR bullet: inside a "Candidates should be able
      // to:" block, lines like "1    describe …" match TOPIC_RX too. A title
      // whose first token is a command verb ("describe", "state", …) inside
      // that block is a bullet, not a new topic. Outside the candidates
      // block, any TOPIC_RX match is a real topic header — 9705 Design &
      // Technology has legitimate topic titles starting with "Design".
      const looksLikeBullet = topicMatch && startsWithCommandWord(topicMatch[2]);
      if (topicMatch && inCandidatesBlock && !subtopicMatch && looksLikeBullet) {
        // fall through to the bullet handler below
      } else if (topicMatch && !subtopicMatch) {
        flushBullet();
        flushDtBullet();
        inCandidatesBlock = false;
        const [, number, title] = topicMatch;
        activeTopic = topicIndex.get(number) ?? {
          number,
          title: collapseWhitespace(title),
          strandName: currentStrand,
          subtopics: [],
        };
        if (!topicIndex.has(number)) {
          topicIndex.set(number, activeTopic);
          topics.push(asParsedTopic(activeTopic));
        } else if (activeTopic.title === number) {
          // Recover a placeholder title set earlier when a subtopic appeared
          // before the topic header (happens when headers are rendered inside
          // a wide table, e.g. 9701 Chemistry topics 13 / 29).
          activeTopic.title = collapseWhitespace(title);
        }
        activeSubtopic = null;
        continue;
      }

      if (subtopicMatch) {
        flushBullet();
        flushDtBullet();
        inCandidatesBlock = false;
        const [, number, title] = subtopicMatch;
        const parent = number.split(".")[0];
        // Switch to the correct parent topic when the subtopic belongs to a
        // different one than the currently active topic (e.g. a missed topic
        // header, or 9700 Biology where "10 Infectious diseases" uses single-
        // space separator and can slip past TOPIC_RX).
        if (!activeTopic || activeTopic.number !== parent) {
          const existing = topicIndex.get(parent);
          if (existing) {
            activeTopic = existing;
          } else {
            activeTopic = {
              number: parent,
              title: parent,
              strandName: currentStrand,
              subtopics: [],
            };
            topicIndex.set(parent, activeTopic);
            topics.push(asParsedTopic(activeTopic));
            warnings.push(`Pattern A: subtopic ${number} seen before its topic header; synthesised parent ${parent}`);
          }
        }
        activeSubtopic = activeTopic.subtopics.find((s) => s.number === number) ?? null;
        if (!activeSubtopic) {
          activeSubtopic = {
            number,
            title: collapseWhitespace(title),
            levelTier: section.tier,
            requirements: [],
          };
          activeTopic.subtopics.push(activeSubtopic);
        }
        continue;
      }

      if (CANDIDATES_HEADER.test(trimmed)) {
        flushBullet();
        flushDtBullet();
        inCandidatesBlock = true;
        continue;
      }

      // 9705 Design & Technology: `•` bullets appear directly under a topic
      // with no N.M subtopic and no "Candidates should be able to:" header.
      // Auto-create a "Content" subtopic and harvest each bullet as an LR.
      const dtBulletMatch = !inCandidatesBlock ? DT_BULLET_RX.exec(raw) : null;
      if (dtBulletMatch && activeTopic) {
        flushDtBullet();
        ensureDtSubtopic();
        dtBulletBuffer = { lines: [dtBulletMatch[1].trim()] };
        continue;
      }

      const dtSubBulletMatch = !inCandidatesBlock ? DT_SUB_BULLET_RX.exec(raw) : null;
      if (dtSubBulletMatch && dtBulletBuffer) {
        dtBulletBuffer.lines.push(dtSubBulletMatch[1].trim());
        continue;
      }

      if (dtBulletBuffer && !inCandidatesBlock) {
        // Continuation of the current DT bullet (wrapped line).
        dtBulletBuffer.lines.push(trimmed);
        continue;
      }

      if (!inCandidatesBlock || !activeSubtopic) {
        continue;
      }

      const bulletMatch = REQUIREMENT_RX.exec(raw);
      if (bulletMatch) {
        flushBullet();
        const [, nStr, rest] = bulletMatch;
        bulletBuffer = { bullet: parseInt(nStr, 10), lines: [rest] };
        continue;
      }

      if (bulletBuffer) {
        bulletBuffer.lines.push(trimmed);
      }
    }

    flushBullet();
    flushDtBullet();
  }

  recoverSynthTopicTitles(text, topicIndex);

  // Promote the working subtopics onto the parsed topics (the entries in
  // `topics` are references to the same sub-arrays via asParsedTopic — we
  // rebuild to ensure the outer array is consistent).
  const finalTopics = topics.map((t, idx): ParsedTopic => {
    const working = Array.from(topicIndex.values())[idx];
    return {
      number: working.number,
      title: working.title,
      strandName: working.strandName,
      subtopics: working.subtopics.map((s): ParsedSubtopic => ({
        number: s.number,
        title: s.title,
        levelTier: s.levelTier,
        requirements: s.requirements,
      })),
    };
  });

  return {
    syllabusCode,
    pattern: "A",
    strands: buildStrands(finalTopics),
    papers: [],
    topics: finalTopics,
    warnings,
  };
}

function splitPatternASections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;

  const pushCurrent = () => {
    if (current && current.lines.length) sections.push(current);
    current = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (END_OF_CONTENT.test(trimmed) && current) {
      pushCurrent();
      continue;
    }
    if (SECTION_AS.test(trimmed)) {
      pushCurrent();
      current = { tier: "AS", lines: [] };
      continue;
    }
    if (SECTION_A.test(trimmed)) {
      pushCurrent();
      current = { tier: "A2", lines: [] };
      continue;
    }
    if (SECTION_PRACTICAL.test(trimmed)) {
      pushCurrent();
      // Practical skills currently roll up under A2 for persistence; Phase 4
      // can split them out separately if the resolver needs the distinction.
      current = { tier: "A2", lines: [] };
      continue;
    }
    if (current) current.lines.push(raw);
  }
  pushCurrent();
  return sections;
}

function buildStrands(topics: ParsedTopic[]) {
  const seen = new Map<string, number>();
  for (const t of topics) {
    if (!t.strandName) continue;
    if (!seen.has(t.strandName)) seen.set(t.strandName, seen.size + 1);
  }
  return Array.from(seen.entries()).map(([name, sortOrder]) => ({ name, sortOrder }));
}

function asParsedTopic(working: WorkingTopic): ParsedTopic {
  return {
    number: working.number,
    title: working.title,
    strandName: working.strandName,
    subtopics: [],
  };
}

function emptyParsed(syllabusCode: string, warnings: string[]): ParsedSyllabus {
  return { syllabusCode, pattern: "A", strands: [], papers: [], topics: [], warnings };
}

/**
 * Post-pass: replace any topic whose title still equals its number with the
 * first deep-indented `NN    Title` line we can find in the raw text.
 * Cambridge 9701 Chemistry renders its organic-chemistry topic headers inside
 * a functional-group table whose pdftotext output pushes the heading to
 * column 40+ — the main TOPIC_RX caps leading whitespace at 16 so these get
 * missed and a placeholder is synthesised when the first subtopic is seen.
 */
function recoverSynthTopicTitles(text: string, topicIndex: Map<string, WorkingTopic>): void {
  const synth = new Map<string, WorkingTopic>();
  for (const [num, t] of topicIndex) {
    if (t.title === num) synth.set(num, t);
  }
  if (!synth.size) return;

  for (const raw of text.split(/\r?\n/)) {
    const m = DEEP_TOPIC_RX.exec(raw);
    if (!m) continue;
    const [, num, title] = m;
    const target = synth.get(num);
    if (!target) continue;
    const clean = collapseWhitespace(title).replace(/\s+continued$/i, "");
    if (!clean || clean === num) continue;
    target.title = clean;
    synth.delete(num);
    if (!synth.size) break;
  }
}

function startsWithCommandWord(title: string): boolean {
  const first = title.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/[.,:;()]+$/g, "") ?? "";
  return first in COMMAND_WORD_COMPETENCY_MAP;
}
