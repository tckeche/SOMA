/**
 * Dispatches a classified syllabus to its pattern-specific parser and
 * returns a normalised `ParsedSyllabus`. An "unclassified" result yields
 * `null` — the orchestrator turns that into a skipped row in the plan
 * output.
 */

import type { SyllabusPattern } from "../patterns";
import { parsePatternA } from "./patternA";
import { parsePatternB } from "./patternB";
import { parsePatternC } from "./patternC";
import { parsePatternD } from "./patternD";
import { parsePatternE } from "./patternE";
import type { ParsedSyllabus } from "./types";

export { type ParsedSyllabus, type ParsedTopic, type ParsedSubtopic, type ParsedRequirement, type ParsedPaper, type ParsedStrand } from "./types";

export interface ParseInput {
  syllabusCode: string;
  pattern: SyllabusPattern;
  text: string;
}

export function parseSyllabus(input: ParseInput): ParsedSyllabus | null {
  switch (input.pattern) {
    case "A":
      return parsePatternA(input.syllabusCode, input.text);
    case "B":
      return parsePatternB(input.syllabusCode, input.text);
    case "C":
      return parsePatternC(input.syllabusCode, input.text);
    case "D":
      return parsePatternD(input.syllabusCode, input.text);
    case "E":
      return parsePatternE(input.syllabusCode, input.text);
    case "unclassified":
      // Non-classified syllabi are handled in Phase 3c.
      return null;
  }
}
