/**
 * Dispatches a classified syllabus to its pattern-specific parser and
 * returns a normalised `ParsedSyllabus`. Unsupported patterns (B, C and
 * "unclassified" in Phase 3b.1) yield a stub result with a warning — the
 * orchestrator turns that into a skipped row in the plan output.
 */

import type { SyllabusPattern } from "../patterns";
import { parsePatternA } from "./patternA";
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
    case "D":
      return parsePatternD(input.syllabusCode, input.text);
    case "B":
    case "C":
    case "unclassified":
      // Patterns B and C arrive in Phase 3b.2. Non-classified syllabi are
      // handled in Phase 3c.
      return null;
  }
}
