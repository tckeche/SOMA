/**
 * Pattern C parser — Cambridge 9708 Economics, 9609 Business, 9706 Accounting.
 *
 * Structure:
 *
 *     3 Subject content
 *       1   Basic economic ideas and resource allocation (AS Level)
 *       <descriptive intro paragraph>
 *
 *       1.1    Scarcity, choice and opportunity cost
 *       1.1.1  fundamental economic problem of scarcity
 *       1.1.2  need to make choices at all levels (…)
 *       …
 *
 *       1.2    Economic methodology
 *       1.2.1  economics as a social science
 *       …
 *
 *       7      The price system and the microeconomy (A Level)
 *       7.1    Utility
 *       …
 *
 * Differences from A and B:
 *   - Learning requirements are numbered three-deep ("N.M.P") and carry
 *     descriptive prose rather than command-verb bullets, so competency
 *     tagging falls back to the default knowledge/understanding pair.
 *   - Level tier is embedded in the topic title as "(AS Level)" / "(A Level)".
 *   - Papers carry level tiers directly (1–2 AS, 3–4 A2). Topics map to
 *     papers by their level tier.
 */

import { commandWordOf } from "../commandWords";
import type { LevelTier } from "@shared/schema";
import type { ParsedSyllabus, ParsedTopic, ParsedSubtopic, ParsedRequirement, ParsedPaper } from "./types";
import { collapseWhitespace, isPageNoise } from "./shared";

const SECTION_START = /^\s*3\s+Subject content\s*$/;
const SECTION_END = /^\s*4\s+Details of the assessment\b/;

// Topic header with tier suffix: "1  Basic economic ideas ... (AS Level)".
// Allow an optional "continued" banner after the parenthetical tier.
const TOPIC_RX = /^\s{0,16}(\d{1,2})\s+([^\n]+?)\s*\((AS Level|A Level)\)(?:\s+continued)?\s*$/;

// Subtopic: "1.1  Scarcity, choice and opportunity cost". 9708 uses a mix of
// tabs and spaces between number and title, so allow any whitespace run.
const SUBTOPIC_RX = /^\s{0,16}(\d{1,2}\.\d{1,2})\s+([A-Za-z][^\n]*?)(?:\s+continued)?\s*$/;

// Learning requirement: "1.1.1   fundamental economic problem of scarcity".
const REQUIREMENT_RX = /^\s{0,16}(\d{1,2}\.\d{1,2}\.\d{1,2})\s+(.*)$/;

// Bullet item underneath a three-level "1.1.1" heading (9706 Accounting,
// 9609 Business). 9708 Economics mostly omits bullets and uses the heading
// text as the learning requirement directly.
const BULLET_RX = /^\s{0,20}•\s+(.*)$/;

// Sub-bullet ("dash list"): "  –  sole trader" under a parent bullet. We fold
// these into the parent statement so the LR text stays cohesive.
const SUB_BULLET_RX = /^\s{0,24}–\s+(.*)$/;

// Cambridge boilerplate lines that appear between an N.N.N heading and the
// bullet list on 9706 Accounting and 9609 Business. They are not content and
// should not pollute the heading text we emit as an LR.
const BOILERPLATE_INTRO = /^(?:Candidates should (?:have an understanding of|also have (?:a )?basic understanding of|know|be able to)|Candidates (?:will|are) (?:expected|explore|investigate))\b/i;

interface WorkingSubtopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  paperNumbers: number[];
  requirements: ParsedRequirement[];
}

interface WorkingTopic {
  number: string;
  title: string;
  levelTier: LevelTier;
  paperNumbers: number[];
  subtopics: WorkingSubtopic[];
}

// Hard-coded paper layouts shared by 9708/9609/9706. Titles are generic so
// they're useful for the UI; the syllabus overview tables encode paper-
// specific styles and durations which Phase 3c can refine.
const PAPERS: Record<string, ParsedPaper[]> = {
  "9708": [
    { number: 1, title: "Paper 1 — AS Level Multiple Choice", levelTier: "AS" },
    { number: 2, title: "Paper 2 — AS Level Data Response and Essays", levelTier: "AS" },
    { number: 3, title: "Paper 3 — A Level Multiple Choice", levelTier: "A2" },
    { number: 4, title: "Paper 4 — A Level Data Response and Essays", levelTier: "A2" },
  ],
  "9609": [
    { number: 1, title: "Paper 1 — AS Level Short Answer and Essay", levelTier: "AS" },
    { number: 2, title: "Paper 2 — AS Level Data Response", levelTier: "AS" },
    { number: 3, title: "Paper 3 — A Level Essay", levelTier: "A2" },
    { number: 4, title: "Paper 4 — A Level Case Study", levelTier: "A2" },
  ],
  "9706": [
    { number: 1, title: "Paper 1 — AS Level Multiple Choice", levelTier: "AS" },
    { number: 2, title: "Paper 2 — AS Level Structured Questions", levelTier: "AS" },
    { number: 3, title: "Paper 3 — A Level Structured Questions", levelTier: "A2" },
    { number: 4, title: "Paper 4 — A Level Problem Solving", levelTier: "A2" },
  ],
};

function papersForTier(code: string, tier: LevelTier): number[] {
  const papers = PAPERS[code] ?? [];
  return papers.filter((p) => p.levelTier === tier).map((p) => p.number);
}

export function parsePatternC(syllabusCode: string, text: string): ParsedSyllabus {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  const contentLines = sliceSubjectContent(lines);

  const topicIndex = new Map<string, WorkingTopic>();
  const topicsOrder: WorkingTopic[] = [];

  let activeTopic: WorkingTopic | null = null;
  let activeSubtopic: WorkingSubtopic | null = null;
  // Active three-level heading ("1.1.1 Types of business entity"). In 9708
  // the heading itself is usually the requirement; in 9609/9706 the heading
  // is followed by `•` bullets that each become their own LR. When bullets
  // appear we emit the heading first (as context) and then each bullet.
  let pendingHeading: { lines: string[] } | null = null;
  let bulletBuffer: { lines: string[] } | null = null;

  const flushHeading = () => {
    if (!pendingHeading || !activeSubtopic) {
      pendingHeading = null;
      return;
    }
    const statement = collapseWhitespace(pendingHeading.lines.join(" "));
    if (statement) {
      activeSubtopic.requirements.push({
        statement,
        commandWord: commandWordOf(statement),
      });
    }
    pendingHeading = null;
  };

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

  const flushRequirement = () => {
    flushBullet();
    flushHeading();
  };

  for (const raw of contentLines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      flushRequirement();
      continue;
    }
    if (isPageNoise(trimmed)) continue;

    const topicMatch = TOPIC_RX.exec(raw);
    if (topicMatch) {
      flushRequirement();
      const [, number, title, tierRaw] = topicMatch;
      const tier: LevelTier = tierRaw === "AS Level" ? "AS" : "A2";
      if (!topicIndex.has(number)) {
        const t: WorkingTopic = {
          number,
          title: collapseWhitespace(title),
          levelTier: tier,
          paperNumbers: papersForTier(syllabusCode, tier),
          subtopics: [],
        };
        topicIndex.set(number, t);
        topicsOrder.push(t);
      }
      activeTopic = topicIndex.get(number)!;
      activeSubtopic = null;
      continue;
    }

    // Three-level numbered heading: must come before the two-level subtopic
    // check so "1.1.1" isn't swallowed as subtopic "1.1" with trailing
    // ".1 fundamental …".
    const reqMatch = REQUIREMENT_RX.exec(raw);
    if (reqMatch) {
      flushRequirement();
      if (!activeSubtopic) {
        warnings.push(`Pattern C: heading ${reqMatch[1]} before any subtopic header — skipped`);
        continue;
      }
      pendingHeading = { lines: [reqMatch[2].trim()] };
      continue;
    }

    const subtopicMatch = SUBTOPIC_RX.exec(raw);
    if (subtopicMatch) {
      flushRequirement();
      const [, number, title] = subtopicMatch;
      if (!activeTopic) {
        warnings.push(`Pattern C: subtopic ${number} before any topic header — skipped`);
        continue;
      }
      activeSubtopic = activeTopic.subtopics.find((s) => s.number === number) ?? null;
      if (!activeSubtopic) {
        activeSubtopic = {
          number,
          title: collapseWhitespace(title),
          levelTier: activeTopic.levelTier,
          paperNumbers: [...activeTopic.paperNumbers],
          requirements: [],
        };
        activeTopic.subtopics.push(activeSubtopic);
      }
      continue;
    }

    // Bullet under the active three-level heading — emit one LR per bullet.
    const bulletMatch = BULLET_RX.exec(raw);
    if (bulletMatch) {
      flushBullet();
      // Emit the heading first so the bullets keep their context, then
      // accumulate this bullet as a fresh LR.
      flushHeading();
      bulletBuffer = { lines: [bulletMatch[1].trim()] };
      continue;
    }

    // Sub-bullets ("  – sole trader") belong to the current bullet.
    const subBulletMatch = SUB_BULLET_RX.exec(raw);
    if (subBulletMatch) {
      if (bulletBuffer) {
        bulletBuffer.lines.push(subBulletMatch[1].trim());
      }
      continue;
    }

    // Boilerplate introductions ("Candidates should have an understanding
    // of:") sit between a heading and its bullets. Skip them so they don't
    // pollute the heading text.
    if (BOILERPLATE_INTRO.test(trimmed)) continue;

    // Continuation of the active bullet or heading.
    if (bulletBuffer) {
      bulletBuffer.lines.push(trimmed);
      continue;
    }
    if (pendingHeading) {
      pendingHeading.lines.push(trimmed);
    }
  }

  flushRequirement();

  const papers = PAPERS[syllabusCode] ?? [];

  const parsedTopics: ParsedTopic[] = topicsOrder.map((t): ParsedTopic => ({
    number: t.number,
    title: t.title,
    paperNumbers: t.paperNumbers,
    subtopics: t.subtopics.map((s): ParsedSubtopic => ({
      number: s.number,
      title: s.title,
      levelTier: s.levelTier,
      paperNumbers: s.paperNumbers,
      requirements: s.requirements,
    })),
  }));

  return {
    syllabusCode,
    pattern: "C",
    strands: [],
    papers,
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
