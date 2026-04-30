/**
 * Normalise noisy legacy question-topic tags before catalogue matching.
 *
 * Quiz-import payloads have come from many tools over the years and the
 * tags carry assorted bookkeeping noise that the catalogue resolver has no
 * way to strip on its own:
 *
 *   - paper / section codes:  "S-Writing.1", "E2.6 …", "9.2 Algorithms"
 *   - paper-name prefixes:    "Pure Mathematics 1_Series"
 *   - bracketed annotations:  "[IGCSE/extended]", "(Higher)", "{paper 1}"
 *   - trailing boilerplate:   "… Notes and examples"
 *   - composite "topic, subtopic" tags packed into one field
 *   - underscore separators between section labels
 *
 * The normaliser strips/cleans these so the resolver's exact and fuzzy
 * passes get a clean title to match against. It is **idempotent** for
 * strings that contain none of the noise patterns above.
 *
 * ⚠ Destructive on commas. The composite-tag rule unconditionally keeps
 * only the trailing comma-separated segment, so a clean catalogue title
 * like "Motion, forces and energy" would be reduced to "energy". The
 * resolver protects clean titles by running a raw-first lookup pass and
 * only invoking this normaliser as a fallback when the raw pass misses.
 * Callers must therefore pass **raw** strings into `resolveSubtopicId`
 * and let the resolver decide when to normalise — never pre-normalise
 * before calling the resolver.
 *
 * Examples (verified by `tests/questionTagNormalizer.test.ts`):
 *
 *   "S-Writing.1"                                     -> "Writing"
 *   "9.2 Algorithms"                                  -> "Algorithms"
 *   "2 Algebra and graphs"                            -> "Algebra and graphs"
 *   "Pure Mathematics 1_Series"                       -> "Series"
 *   "E2.6 Inequalities Notes and examples [IGCSE/…]"  -> "Inequalities"
 *   "Describe a species…, Cell structure"             -> "Cell structure"
 */

function collapseSpaces(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/** One pass of stripping. We loop until the string stops shrinking so a
 *  combination of prefixes (e.g. "S-2.1 …") gets fully cleaned. */
function stripOnce(input: string): string {
  let out = input;

  // Strip trailing bracketed/parenthesised/brace annotations, including
  // any trailing whitespace after them. Repeats handle `… [a] (b)`.
  out = out.replace(/\s*[\[\(\{][^\]\)\}]*[\]\)\}]\s*$/g, "");

  // Strip trailing boilerplate like "Notes and examples", "notes & examples".
  out = out.replace(
    /\s+(?:notes?(?:\s*(?:and|&)\s*examples?)?|examples?)\s*$/i,
    "",
  );

  // Underscores between section parts → spaces.
  out = out.replace(/_/g, " ");

  // Leading short paper-code prefixes like "S-", "E:", "P1-".
  out = out.replace(/^[A-Za-z]{1,3}\d*\s*[-:]\s*/g, "");

  // Leading numeric section prefixes: "9.2 ", "2 ", "E2.6 ", etc.
  out = out.replace(/^[A-Za-z]?\d+(?:\.\d+)*\s+/g, "");

  // Broad paper-name prefixes before the actual subtopic token.
  // e.g. "Pure Mathematics 1 Series" → "Series", but never strip when
  // nothing follows so the catalogue subject is still recognisable.
  out = out.replace(
    /^(?:pure\s+mathematics|mathematics|additional\s+mathematics|further\s+mathematics)\s+\d+\s+(?=\S)/i,
    "",
  );

  // Trailing ".\d+" suffix (paper question-number variants like
  // "Writing.1" → "Writing").
  out = out.replace(/\.\d+\s*$/g, "");

  return collapseSpaces(out);
}

export function normalizeQuestionTag(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let out = raw.trim();
  if (!out) return null;

  // Composite "topic, subtopic" tags: take the trailing comma-separated
  // segment, which is overwhelmingly the most specific. This *will*
  // mangle clean catalogue titles that legitimately contain commas
  // ("Motion, forces and energy" → "energy"), so callers must let the
  // resolver try the raw string first (see header docstring) and only
  // fall back to this normaliser when the raw pass misses.
  const commaSegments = out.split(",").map((s) => s.trim()).filter(Boolean);
  if (commaSegments.length > 1) {
    out = commaSegments[commaSegments.length - 1];
  }

  // Iteratively strip until stable; each pass may expose another layer
  // (e.g. "[IGCSE]" sits after a numeric prefix that itself sat after a
  // bracket annotation in some legacy rows).
  let prev = "";
  let guard = 0;
  while (out && out !== prev && guard < 6) {
    prev = out;
    out = stripOnce(out);
    guard++;
  }

  return out || null;
}
