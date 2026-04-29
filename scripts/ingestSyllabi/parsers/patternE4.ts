/**
 * Pattern E4 — humanities syllabi whose subject content is organised around
 * themes, options, periods or prescribed skills rather than numbered LR
 * tables. Five syllabi fall into this group:
 *
 *   0520  IGCSE French                — Skills + Topic areas A–E
 *   9898  A Level French Lang & Lit   — Skills (B2/C1) + Topic areas 1–6
 *   0470  IGCSE History               — Core Option A/B + Depth studies A–E
 *   9489  A Level History             — European/American/International options
 *   9696  A Level Geography           — AS topics 1–6 (Papers 1/2) + A Level topics 7–10
 *
 * Each shape is different enough that a single generic walker would either
 * miss content or produce garbage. Instead we dispatch on the syllabus code
 * to a small per-syllabus parser. The shared helpers used by every parser
 * (state book-keeping, bullet detection, section slicing) live in
 * `./patternE4_helpers` so the variants and this dispatcher both depend on a
 * neutral module rather than each other.
 */

import type { ParsedSyllabus } from "./types";
import { parse0520, parse9898 } from "./patternE4_french";
import { parse9696 } from "./patternE4_9696";
import { parse9489 } from "./patternE4_9489";
import { parse0470 } from "./patternE4_0470";

export function parsePatternE4(syllabusCode: string, text: string): ParsedSyllabus {
  switch (syllabusCode) {
    case "0520":
      return parse0520(text);
    case "9898":
      return parse9898(text);
    case "9696":
      return parse9696(text);
    case "9489":
      return parse9489(text);
    case "0470":
      return parse0470(text);
    // Additional syllabi wired in below as their parsers land.
    default:
      return {
        syllabusCode,
        pattern: "E",
        strands: [],
        papers: [],
        topics: [],
        warnings: [`Pattern E4: no parser implemented for ${syllabusCode} yet`],
      };
  }
}
