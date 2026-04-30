/**
 * Normalise noisy legacy question-topic tags before catalogue matching.
 *
 * Examples:
 * - "S-Writing.1" -> "Writing"
 * - "9.2 Algorithms" -> "Algorithms"
 * - "2 Algebra and graphs" -> "Algebra and graphs"
 * - "Pure Mathematics 1_Series" -> "Series"
 * - "E2.6 Inequalities Notes and examples [IGCSE/extended]" -> "Inequalities Notes and examples"
 */

function collapseSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function normalizeQuestionTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let out = raw.trim();
  if (!out) return null;

  // Remove trailing bracketed noise, e.g. [IGCSE/extended]
  out = out.replace(/\[[^\]]*\]\s*$/g, "");

  // Replace underscores with spaces for tokenization.
  out = out.replace(/_/g, " ");

  // Remove leading short paper-code prefixes (e.g. S-, E-, P1-)
  out = out.replace(/^[A-Za-z]{1,3}\s*[-:]\s*/g, "");

  // Remove leading numeric section prefixes: 9.2, 2, E2.6, etc.
  out = out.replace(/^[A-Za-z]?\d+(?:\.\d+)*\s+/g, "");

  // Remove broad paper-name prefixes before a subtopic token.
  // e.g. "Pure Mathematics 1 Series" -> "Series"
  out = out.replace(/^(?:pure\s+mathematics|mathematics|additional\s+mathematics)\s+\d+\s+/i, "");

  out = collapseSpaces(out);
  return out || null;
}
