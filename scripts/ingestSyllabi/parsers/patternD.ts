/**
 * Pattern D parser — Cambridge IGCSE Core / Extended layouts.
 *
 * Two variants ship under this pattern:
 *
 *   D-math (0580): two serial sections, "Core subject content" then
 *                  "Extended subject content". Subtopic numbers carry a
 *                  C/E prefix ("C1.1", "E1.17"). Core stubs like
 *                  "C1.17 Extended content only." are skipped.
 *
 *   D-science (0610, 0620, 0625): one section ("3 Subject content") with
 *                  per-subtopic two-column tables headed "Core | Supplement".
 *                  Numbered bullets continue across columns (Core 1–4,
 *                  Supplement 5–7). Left-column bullets become Core LRs,
 *                  right-column bullets become Extended LRs.
 *
 * Both variants surface the same ParsedSyllabus shape. Subtopic numbers are
 * carried through with their Cambridge prefix where one is present; D-science
 * subtopics (which have no prefix) are emitted with the plain "N.M" form and
 * one subtopic row per tier it appears in.
 */

import { commandWordOf } from "../commandWords";
import type { CoreOrExtended } from "@shared/schema";
import type { ParsedSyllabus, ParsedTopic, ParsedSubtopic, ParsedRequirement } from "./types";
import { collapseWhitespace, isContinuationBanner, isPageNoise, splitColumns } from "./shared";

const SECTION_CORE = /^\s*Core subject content\s*$/i;
const SECTION_EXTENDED = /^\s*Extended subject content\s*$/i;
const SECTION_PRACTICAL = /^\s*Practical (?:skills|assessment|work|activity) subject content\s*$/i;
const SECTION_FALLBACK = /^\s*\d+\s+Subject content\s*$/i;
const END_OF_CONTENT = /^\s*(?:4\s+Details of the assessment|Command words|Appendix|Mathematical formulae|Glossary)\b/i;

const TOPIC_RX = /^\s{0,16}(\d{1,2})\s{3,}([A-Z][^\n]*?)\s*$/;
const SUBTOPIC_PREFIXED_RX = /^\s{0,18}([CE])(\d{1,2}\.\d{1,2})\s+([A-Z][^\n]*?)\s*$/;
const SUBTOPIC_PLAIN_RX = /^\s{0,18}(\d{1,2}\.\d{1,2})\s+([A-Z][^\n]*?)\s*$/;
const EXTENDED_STUB_RX = /\bExtended content only\b/i;
const CORE_SUPPLEMENT_HEADER_RX = /^\s*Core\s{2,}.*Supplement\s*$/i;
const NUMBERED_IMPERATIVE_RX = /^\s{0,10}(\d{1,2})\s+([A-Z].*?)\s*$/;
const NUMBERED_LR_RX = /^\s{0,80}(\d{1,2})\s+([A-Za-z].*?)\s*$/;
const BULLET_RX = /^\s*[•·]\s*(.+?)\s*$/;

interface WorkingSubtopic {
  number: string;
  title: string;
  coreOrExtended: CoreOrExtended | null;
  requirements: ParsedRequirement[];
  /** D-math only: left-column prose awaiting conversion to one requirement. */
  leftBuffer: string[];
  /** D-science: each column gathers its own raw left/right content lines. */
  coreLines: string[];
  supplementLines: string[];
  columnMode: boolean;
}

interface WorkingTopic {
  number: string;
  title: string;
  subtopics: WorkingSubtopic[];
}

type SectionLabel = "core" | "extended" | "practical" | "unified";

interface Section {
  label: SectionLabel;
  lines: string[];
}

export function parsePatternD(syllabusCode: string, text: string): ParsedSyllabus {
  const warnings: string[] = [];
  const sections = splitPatternDSections(text);
  if (!sections.length) {
    warnings.push(`Pattern D: no Subject content section found`);
    return emptyParsed(syllabusCode, warnings);
  }

  const topicIndex = new Map<string, WorkingTopic>();
  const subtopicIndex = new Map<string, WorkingSubtopic>();

  for (const section of sections) {
    let activeTopic: WorkingTopic | null = null;
    let activeSubtopic: WorkingSubtopic | null = null;

    const flushSubtopic = () => {
      if (!activeSubtopic) return;
      finaliseSubtopic(activeSubtopic, warnings);
    };

    for (const raw of section.lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (isPageNoise(trimmed)) continue;
      if (isContinuationBanner(trimmed)
          && !SUBTOPIC_PREFIXED_RX.test(trimmed)
          && !SUBTOPIC_PLAIN_RX.test(trimmed)
          && !TOPIC_RX.test(trimmed)) {
        continue;
      }

      const topicMatch = TOPIC_RX.exec(raw);
      const prefixedMatch = SUBTOPIC_PREFIXED_RX.exec(raw);
      const plainMatch = !prefixedMatch ? SUBTOPIC_PLAIN_RX.exec(raw) : null;

      if (topicMatch && !prefixedMatch && !plainMatch) {
        flushSubtopic();
        activeSubtopic = null;
        const [, number, title] = topicMatch;
        activeTopic = topicIndex.get(number) ?? {
          number,
          title: collapseWhitespace(title),
          subtopics: [],
        };
        topicIndex.set(number, activeTopic);
        continue;
      }

      if (prefixedMatch) {
        flushSubtopic();
        const [, prefix, suffix, title] = prefixedMatch;
        if (EXTENDED_STUB_RX.test(raw)) {
          activeSubtopic = null;
          continue;
        }
        const tier = prefix === "C" ? "core" : "extended";
        const number = `${prefix}${suffix}`;
        const parentNum = suffix.split(".")[0];
        if (!activeTopic || activeTopic.number !== parentNum) {
          activeTopic = topicIndex.get(parentNum) ?? {
            number: parentNum,
            title: parentNum,
            subtopics: [],
          };
          topicIndex.set(parentNum, activeTopic);
        }
        activeSubtopic = getOrCreateSubtopic(activeTopic, subtopicIndex, {
          number,
          title: collapseWhitespace(title),
          coreOrExtended: tier,
          columnMode: false,
        });
        continue;
      }

      if (plainMatch) {
        flushSubtopic();
        const [, suffix, title] = plainMatch;
        const parentNum = suffix.split(".")[0];
        if (!activeTopic || activeTopic.number !== parentNum) {
          activeTopic = topicIndex.get(parentNum) ?? {
            number: parentNum,
            title: parentNum,
            subtopics: [],
          };
          topicIndex.set(parentNum, activeTopic);
        }
        activeSubtopic = getOrCreateSubtopic(activeTopic, subtopicIndex, {
          number: suffix,
          title: collapseWhitespace(title),
          coreOrExtended: null,
          columnMode: false,
        });
        continue;
      }

      if (!activeSubtopic) continue;

      if (CORE_SUPPLEMENT_HEADER_RX.test(trimmed)) {
        activeSubtopic.columnMode = true;
        continue;
      }

      if (activeSubtopic.columnMode) {
        const split = splitColumns(raw);
        if (split) {
          activeSubtopic.coreLines.push(split.left);
          activeSubtopic.supplementLines.push(split.right);
        } else if (isRightColumnOnlyLine(raw)) {
          activeSubtopic.supplementLines.push(trimmed);
        } else {
          activeSubtopic.coreLines.push(trimmed);
        }
      } else {
        const split = splitColumns(raw);
        const leftText = split ? split.left.trim() : trimmed;
        activeSubtopic.leftBuffer.push(leftText);
      }
    }

    flushSubtopic();
  }

  const topics: ParsedTopic[] = Array.from(topicIndex.values()).map((t): ParsedTopic => ({
    number: t.number,
    title: t.title,
    subtopics: t.subtopics.map((s): ParsedSubtopic => ({
      number: s.number,
      title: s.title,
      levelTier: "IGCSE",
      coreOrExtended: s.coreOrExtended ?? undefined,
      requirements: s.requirements,
    })),
  }));

  return {
    syllabusCode,
    pattern: "D",
    strands: [],
    papers: [],
    topics,
    warnings,
  };
}

interface SubtopicSeed {
  number: string;
  title: string;
  coreOrExtended: CoreOrExtended | null;
  columnMode: boolean;
}

function getOrCreateSubtopic(
  topic: WorkingTopic,
  index: Map<string, WorkingSubtopic>,
  seed: SubtopicSeed,
): WorkingSubtopic {
  const key = `${topic.number}::${seed.number}`;
  const existing = index.get(key);
  if (existing) return existing;
  const created: WorkingSubtopic = {
    number: seed.number,
    title: seed.title,
    coreOrExtended: seed.coreOrExtended,
    requirements: [],
    leftBuffer: [],
    coreLines: [],
    supplementLines: [],
    columnMode: seed.columnMode,
  };
  topic.subtopics.push(created);
  index.set(key, created);
  return created;
}

function finaliseSubtopic(sub: WorkingSubtopic, warnings: string[]): void {
  if (sub.columnMode) {
    const coreReqs = extractColumnRequirements(sub.coreLines);
    const supReqs = extractColumnRequirements(sub.supplementLines);
    for (const r of coreReqs) sub.requirements.push(r);
    for (const r of supReqs) sub.requirements.push(r);
    // When content appears on both sides the subtopic spans both tiers;
    // surface that by nulling coreOrExtended — the schema permits null.
    if (coreReqs.length && supReqs.length) sub.coreOrExtended = null;
    else if (coreReqs.length) sub.coreOrExtended = "core";
    else if (supReqs.length) sub.coreOrExtended = "extended";
    sub.coreLines = [];
    sub.supplementLines = [];
    sub.columnMode = false;
    if (!sub.requirements.length) {
      sub.requirements.push({ statement: sub.title, commandWord: commandWordOf(sub.title) });
      warnings.push(`Pattern D: subtopic ${sub.number} produced no column bullets — used title as requirement`);
    }
    return;
  }

  const lines = sub.leftBuffer.filter((l) => l.trim().length > 0);
  sub.leftBuffer = [];
  if (!lines.length) {
    sub.requirements.push({ statement: sub.title, commandWord: commandWordOf(sub.title) });
    return;
  }

  const numberedStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (NUMBERED_IMPERATIVE_RX.test(lines[i])) numberedStarts.push(i);
  }

  if (numberedStarts.length >= 2) {
    numberedStarts.push(lines.length);
    for (let i = 0; i < numberedStarts.length - 1; i++) {
      const start = numberedStarts[i];
      const end = numberedStarts[i + 1];
      const block = lines.slice(start, end);
      const match = NUMBERED_IMPERATIVE_RX.exec(block[0]);
      if (!match) continue;
      const head = match[2];
      const rest = block.slice(1).map((l) => stripBullet(l));
      const statement = collapseWhitespace([head, ...rest].join(" "));
      sub.requirements.push({ statement, commandWord: commandWordOf(statement) });
    }
    return;
  }

  const parts: string[] = [];
  for (const line of lines) {
    const bulletMatch = BULLET_RX.exec(line);
    if (bulletMatch) {
      parts.push(`• ${bulletMatch[1]}`);
    } else {
      parts.push(line.trim());
    }
  }
  const statement = collapseWhitespace(parts.join(" "));
  if (!statement) {
    warnings.push(`Pattern D: subtopic ${sub.number} produced empty statement`);
    return;
  }
  sub.requirements.push({ statement, commandWord: commandWordOf(statement) });
}

function extractColumnRequirements(lines: string[]): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];
  const cleaned = lines.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (!cleaned.length) return out;

  const starts: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (NUMBERED_LR_RX.test(cleaned[i])) starts.push(i);
  }
  if (!starts.length) {
    const statement = collapseWhitespace(cleaned.map((l) => l.trim()).join(" "));
    if (statement) out.push({ statement, commandWord: commandWordOf(statement) });
    return out;
  }
  starts.push(cleaned.length);
  for (let i = 0; i < starts.length - 1; i++) {
    const block = cleaned.slice(starts[i], starts[i + 1]);
    const match = NUMBERED_LR_RX.exec(block[0]);
    if (!match) continue;
    const head = match[2];
    const rest = block.slice(1).map((l) => stripBullet(l.trim()));
    const statement = collapseWhitespace([head, ...rest].join(" "));
    if (statement) out.push({ statement, commandWord: commandWordOf(statement) });
  }
  return out;
}

function isRightColumnOnlyLine(raw: string): boolean {
  // A line that is entirely in the right column (no content in left) — used
  // when the supplement paragraph wraps without a matching left-column line.
  return /^\s{40,}\S/.test(raw);
}

function stripBullet(line: string): string {
  const m = BULLET_RX.exec(line);
  return m ? m[1] : line.trim();
}

function splitPatternDSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const hasExplicitMarkers = lines.some((raw) => {
    const t = raw.trim();
    return SECTION_CORE.test(t) || SECTION_EXTENDED.test(t);
  });

  const sections: Section[] = [];
  let current: Section | null = null;
  const pushCurrent = () => {
    if (current && current.lines.length) sections.push(current);
    current = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (SECTION_CORE.test(trimmed)) { pushCurrent(); current = { label: "core", lines: [] }; continue; }
    if (SECTION_EXTENDED.test(trimmed)) { pushCurrent(); current = { label: "extended", lines: [] }; continue; }
    if (SECTION_PRACTICAL.test(trimmed)) { pushCurrent(); current = { label: "practical", lines: [] }; continue; }
    if (!hasExplicitMarkers && SECTION_FALLBACK.test(trimmed)) {
      pushCurrent();
      current = { label: "unified", lines: [] };
      continue;
    }
    if (END_OF_CONTENT.test(trimmed) && current) {
      pushCurrent();
      continue;
    }
    if (current) current.lines.push(raw);
  }
  pushCurrent();
  return sections;
}

function emptyParsed(syllabusCode: string, warnings: string[]): ParsedSyllabus {
  return { syllabusCode, pattern: "D", strands: [], papers: [], topics: [], warnings };
}
