/**
 * Normalised shape every pattern parser returns.
 *
 * The persistence layer is pattern-agnostic: it walks `ParsedSyllabus` and
 * writes rows into topics / subtopics / learning_requirements / papers /
 * paper_topic_mappings / subtopic_paper_mappings using the numbers as
 * idempotency keys.
 */

import type { LevelTier, CoreOrExtended } from "@shared/schema";

export interface ParsedPaper {
  /** 1-based paper number from the syllabus (Paper 1, Paper 2, …). */
  number: number;
  /** "Pure Mathematics 1", "AS Multiple Choice", etc. */
  title: string;
  levelTier: LevelTier;
  coreOrExtended?: CoreOrExtended;
}

export interface ParsedStrand {
  name: string;
  sortOrder: number;
}

export interface ParsedRequirement {
  /** Free-text statement as it appears on the page. */
  statement: string;
  /** First word after normalisation — drives competency tagging. */
  commandWord: string | null;
  notesAndExamples?: string | null;
}

export interface ParsedSubtopic {
  /**
   * Canonical string ID inside its parent topic, e.g. "1.1" for Pattern A/B/C
   * or "C1.1" / "E1.17" for Pattern D (Core vs Extended variants).
   */
  number: string;
  title: string;
  description?: string | null;
  levelTier: LevelTier;
  coreOrExtended?: CoreOrExtended;
  /** Pattern B and parts of Pattern C: which papers assess this subtopic. */
  paperNumbers?: number[];
  requirements: ParsedRequirement[];
}

export interface ParsedTopic {
  /** Canonical string ID inside the syllabus, e.g. "1", "2", "10". */
  number: string;
  title: string;
  description?: string | null;
  /** Optional grouping (Pattern A Chemistry: Physical/Inorganic/Organic). */
  strandName?: string | null;
  subtopics: ParsedSubtopic[];
  /** Pattern B: which paper(s) cover this component. */
  paperNumbers?: number[];
}

export interface ParsedSyllabus {
  syllabusCode: string;
  pattern: "A" | "B" | "C" | "D";
  strands: ParsedStrand[];
  papers: ParsedPaper[];
  topics: ParsedTopic[];
  /** Diagnostics: warnings the parser surfaced but did not treat as fatal. */
  warnings: string[];
}
