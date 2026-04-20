/**
 * Deterministic mapping from Cambridge command words (and a few non-command
 * verbs that start learning-requirement bullets) to competency tags.
 *
 * Source: the Command Words appendix in every Cambridge syllabus PDF. The
 * mapping was drafted from the Physics 9702 appendix and cross-checked
 * against the Biology 9700, Chemistry 9701 and Economics 9708 appendices —
 * the definitions are standardised across boards.
 *
 * Rules (encoded below):
 *   - A command word can map to multiple competency codes.
 *   - The first token of a "Candidates should be able to …" bullet is the
 *     command word. We compare case-insensitively and strip trailing
 *     punctuation, so `describe,` matches `describe`.
 *   - Unknown command words fall back to the conservative
 *     [knowledge, understanding] pair so we never drop a learning
 *     requirement from the competency rollups.
 */

import type { CompetencyCode } from "@shared/schema";

const MAP: Record<string, CompetencyCode[]> = {
  analyse: ["analysis"],
  apply: ["application"],
  calculate: ["calculation", "application"],
  compare: ["analysis", "evaluation"],
  construct: ["application"],
  deduce: ["analysis", "problem_solving"],
  define: ["knowledge"],
  demonstrate: ["application"],
  derive: ["analysis", "application"],
  describe: ["knowledge", "understanding"],
  design: ["application", "problem_solving"],
  determine: ["calculation", "application"],
  develop: ["application"],
  discuss: ["evaluation", "communication"],
  distinguish: ["analysis"],
  draw: ["communication", "application"],
  estimate: ["calculation", "application"],
  evaluate: ["evaluation"],
  examine: ["analysis", "evaluation"],
  explain: ["understanding", "communication"],
  find: ["calculation", "application"],
  give: ["knowledge"],
  identify: ["knowledge"],
  illustrate: ["communication", "understanding"],
  infer: ["analysis"],
  interpret: ["interpretation"],
  investigate: ["practical_skills", "analysis"],
  justify: ["evaluation", "communication"],
  know: ["knowledge"],
  label: ["knowledge", "communication"],
  list: ["knowledge"],
  measure: ["practical_skills", "calculation"],
  name: ["knowledge"],
  observe: ["practical_skills"],
  outline: ["knowledge", "understanding"],
  plan: ["practical_skills", "problem_solving"],
  plot: ["communication", "practical_skills"],
  predict: ["application", "understanding"],
  prove: ["analysis", "problem_solving"],
  recall: ["knowledge"],
  recognise: ["knowledge"],
  record: ["practical_skills", "communication"],
  relate: ["understanding", "analysis"],
  select: ["application"],
  show: ["application", "communication"],
  sketch: ["communication", "application"],
  solve: ["problem_solving", "application", "calculation"],
  state: ["knowledge"],
  suggest: ["application", "problem_solving"],
  summarise: ["communication", "understanding"],
  understand: ["understanding"],
  use: ["application"],
  verify: ["application", "analysis"],
  write: ["knowledge", "communication"],
};

const FALLBACK: CompetencyCode[] = ["knowledge", "understanding"];

/**
 * Extract the command word from the start of a learning-requirement bullet.
 * Returns `null` if the statement is empty.
 */
export function commandWordOf(statement: string): string | null {
  const trimmed = statement.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  // Strip punctuation (trailing commas/periods/colons).
  const cleaned = first.replace(/[.,:;()]+$/g, "").toLowerCase();
  return cleaned || null;
}

export function competenciesFor(commandWord: string | null | undefined): CompetencyCode[] {
  if (!commandWord) return FALLBACK;
  const normalised = commandWord.toLowerCase();
  return MAP[normalised] ?? FALLBACK;
}

/** Exposed for tests. */
export const COMMAND_WORD_COMPETENCY_MAP = MAP;
