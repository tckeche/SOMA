/**
 * Pattern B parser — Cambridge 9709 Mathematics paper-keyed components.
 *
 * Structure:
 *
 *     3 Subject content
 *       1 Pure Mathematics 1 (for Paper 1)
 *       1.1 Quadratics
 *
 *       Candidates should be able to:                    Notes and examples
 *       •   carry out the process of completing the      e.g. to locate the vertex …
 *           square …
 *       •   find the discriminant …
 *
 *       1.2 Functions
 *       …
 *
 *       2 Pure Mathematics 2 (for Paper 2)
 *       …
 *
 * Differences from Pattern A:
 *   - LRs are • bullets, not "1  ", "2  " numbered items.
 *   - Paper association is embedded in the topic title ("(for Paper N)") so
 *     every topic maps to a single paper.
 *   - Level tier: Papers 1/2/4/5 carry AS content (and Paper 1 also appears
 *     on the A Level routes); Papers 3 and 6 are A Level only.
 */

import { commandWordOf } from "../commandWords";
import type { LevelTier } from "@shared/schema";
import type { ParsedSyllabus, ParsedTopic, ParsedSubtopic, ParsedRequirement, ParsedPaper } from "./types";
import { collapseWhitespace, isContinuationBanner, isPageNoise, splitColumns } from "./shared";

const SECTION_START = /^\s*3\s+Subject content\s*$/;
const SECTION_END = /^\s*4\s+Details of the assessment\b/;

// Topic with paper suffix: "1 Pure Mathematics 1 (for Paper 1)".
const TOPIC_RX = /^\s{0,16}(\d)\s+([A-Z][^\n]*?)\s*\(for Paper (\d)\)\s*$/;

// Subtopic: "1.1 Quadratics", "3.9 Complex numbers".
const SUBTOPIC_RX = /^\s{0,16}(\d\.\d{1,2})\s+([A-Z][^\n]*?)\s*$/;

// Candidates header: anchored loosely because it may share a line with the
// Notes and examples column header.
const CANDIDATES_HEADER = /Candidates should be able to:/i;

// A bullet can start with either `•` or a stray dash. The statement text
// follows after at least one space.
const BULLET_RX = /^\s{0,16}•\s+(.*)$/;

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
  paperNumbers: number[];
  subtopics: WorkingSubtopic[];
}

// Paper 3 (Pure Maths 3) and Paper 6 (P&S 2) are A Level only per the
// "Structure of AS and A Level" table. All other papers can be combined into
// an AS route, so their content is tagged AS.
const A2_ONLY_PAPERS = new Set([3, 6]);

function tierForPaper(paperNumber: number): LevelTier {
  return A2_ONLY_PAPERS.has(paperNumber) ? "A2" : "AS";
}

export function parsePatternB(syllabusCode: string, text: string): ParsedSyllabus {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  const contentLines = sliceSubjectContent(lines);

  const topicIndex = new Map<string, WorkingTopic>();
  const topicsOrder: WorkingTopic[] = [];

  let activeTopic: WorkingTopic | null = null;
  let activeSubtopic: WorkingSubtopic | null = null;
  let inCandidatesBlock = false;
  let bulletBuffer: { leftLines: string[] } | null = null;

  const flushBullet = () => {
    if (!bulletBuffer || !activeSubtopic) {
      bulletBuffer = null;
      return;
    }
    const statement = collapseWhitespace(bulletBuffer.leftLines.join(" "));
    if (statement) {
      activeSubtopic.requirements.push({
        statement,
        commandWord: commandWordOf(statement),
      });
    }
    bulletBuffer = null;
  };

  for (const raw of contentLines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      flushBullet();
      continue;
    }
    if (isPageNoise(trimmed)) continue;

    // Continuation banner: "1       Pure Mathematics 1" (no paper suffix on
    // continuation pages). Swallow the line but keep the current topic/state.
    const topicMatch = TOPIC_RX.exec(raw);
    if (topicMatch) {
      flushBullet();
      inCandidatesBlock = false;
      const [, numberStr, title, paperStr] = topicMatch;
      const paperNumber = parseInt(paperStr, 10);
      if (!topicIndex.has(numberStr)) {
        const t: WorkingTopic = {
          number: numberStr,
          title: collapseWhitespace(title),
          paperNumbers: [paperNumber],
          subtopics: [],
        };
        topicIndex.set(numberStr, t);
        topicsOrder.push(t);
      }
      activeTopic = topicIndex.get(numberStr)!;
      activeSubtopic = null;
      continue;
    }

    // Look for bare "N    Title" continuation banners like "1    Pure
    // Mathematics 1"; just rebind activeTopic and move on.
    const bareBanner = /^\s{0,16}(\d)\s+(Pure Mathematics \d|Mechanics|Probability & Statistics \d)(?:\s+continued)?\s*$/.exec(raw);
    if (bareBanner) {
      const [, numberStr] = bareBanner;
      const existing = topicIndex.get(numberStr);
      if (existing) {
        flushBullet();
        inCandidatesBlock = false;
        activeTopic = existing;
        activeSubtopic = null;
      }
      continue;
    }

    if (isContinuationBanner(trimmed) && !SUBTOPIC_RX.test(trimmed)) {
      continue;
    }

    const subtopicMatch = SUBTOPIC_RX.exec(raw);
    if (subtopicMatch) {
      flushBullet();
      inCandidatesBlock = false;
      const [, number, title] = subtopicMatch;
      if (!activeTopic) {
        warnings.push(`Pattern B: subtopic ${number} before any topic header — skipped`);
        continue;
      }
      activeSubtopic = activeTopic.subtopics.find((s) => s.number === number) ?? null;
      if (!activeSubtopic) {
        activeSubtopic = {
          number,
          title: collapseWhitespace(title),
          levelTier: tierForPaper(activeTopic.paperNumbers[0] ?? 1),
          paperNumbers: [...activeTopic.paperNumbers],
          requirements: [],
        };
        activeTopic.subtopics.push(activeSubtopic);
      }
      continue;
    }

    if (CANDIDATES_HEADER.test(trimmed)) {
      flushBullet();
      inCandidatesBlock = true;
      continue;
    }

    if (!inCandidatesBlock || !activeSubtopic) continue;

    // Bullet lines carry both the candidate statement (left column) and the
    // optional "Notes and examples" text (right column) on the same row. We
    // strip the right column AFTER identifying the bullet so `splitColumns`
    // doesn't treat the 3 spaces between `•` and the statement as a gutter.
    const bulletMatch = BULLET_RX.exec(raw);
    if (bulletMatch) {
      flushBullet();
      const leftOnly = stripRightColumn(bulletMatch[1]);
      bulletBuffer = { leftLines: [leftOnly] };
      continue;
    }

    if (bulletBuffer) {
      // Skip right-column-only continuation lines: when pdftotext renders a
      // "Notes and examples" line without any left-column content, the line
      // is all whitespace up to the gutter (~column 40+). These would
      // otherwise leak into the candidate statement.
      const leadingWs = raw.match(/^\s*/)?.[0].length ?? 0;
      if (leadingWs >= 30) continue;
      bulletBuffer.leftLines.push(stripRightColumn(raw).trim());
    }
  }

  flushBullet();

  const papers = buildPapers(topicsOrder);
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
    pattern: "B",
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

function stripRightColumn(line: string): string {
  const columns = splitColumns(line);
  return columns ? columns.left : line;
}

function buildPapers(topics: WorkingTopic[]): ParsedPaper[] {
  const out: ParsedPaper[] = [];
  const seen = new Set<number>();
  for (const t of topics) {
    for (const paperNumber of t.paperNumbers) {
      if (seen.has(paperNumber)) continue;
      seen.add(paperNumber);
      out.push({
        number: paperNumber,
        title: t.title,
        levelTier: tierForPaper(paperNumber),
      });
    }
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}
