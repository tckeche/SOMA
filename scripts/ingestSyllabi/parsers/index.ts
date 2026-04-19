/**
 * Dispatches a classified syllabus to its pattern-specific parser and
 * returns a normalised `ParsedSyllabus`. Unsupported patterns (B, C and
 * "unclassified" in Phase 3b.1) yield a stub result with a warning — the
 * orchestrator turns that into a skipped row in the plan output.
 */

import type { SyllabusPattern } from "../patterns";
import { parsePatternA } from "./patternA";
import { parsePatternB } from "./patternB";
import { parsePatternC } from "./patternC";
import { parsePatternD } from "./patternD";
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
    case "unclassified":
      // Non-classified syllabi are handled in Phase 3c.
      return null;
  }
}
