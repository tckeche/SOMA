/**
 * Service: deterministic normaliser for `soma_quizzes.syllabus` free-text.
 *
 * Why
 * ───
 * `soma_quizzes.syllabus` is a free-text column populated by a mix of UI
 * inputs (tutor wizard typed strings) and back-end writers
 * (`/api/tutor/ai-publish-suggestions` injects "Cambridge 9709"). Catalogue
 * lookups in `scripts/backfillCatalogueFks.ts` and at runtime require the
 * canonical 4-digit code (e.g. "9709", "0580") to join `syllabi.syllabus_code`.
 *
 * Examples of values seen in production:
 *   "Cambridge"                       → no code, returns null
 *   "Cambridge Syllabus · 9709"       → "9709"
 *   "Cambridge "  (trailing space)    → no code, returns null
 *   "Cambridge · mathematics-0580-…"  → "0580"
 *   "Cambridge (CAIE) 9709"           → "9709"
 *   "9701"                            → "9701"
 *
 * The matcher uses `extractSyllabusCode` to recover the code at lookup time
 * without rewriting the original display string (which the tutor UI shows
 * verbatim). Quiz-save sites use `normalizeQuizSyllabusForWrite` to trim
 * incidental whitespace on the way in.
 */

// Cambridge syllabus codes always start with 0 (IGCSE / O-level: 0xxx) or
// 9 (AS/A-Level: 9xxx). Real-world strings in the wild include date-range
// suffixes like "geography-0460-2027-2029", so an unconstrained `\d{4}`
// regex would happily return "2027" instead of "0460" the moment the
// position of the date moved before the code (e.g. "Cambridge 2027 (0460)").
// We therefore try the Cambridge-shape regex first and only fall back to
// any 4-digit token if the input has no Cambridge-style code at all (so
// non-Cambridge boards are still supported as a best-effort).
const CAMBRIDGE_CODE = /(?<![0-9])([09]\d{3})(?![0-9])/;
const ANY_FOUR_DIGIT = /(?<![0-9])(\d{4})(?![0-9])/;

/**
 * Extract the 4-digit Cambridge syllabus code embedded in a free-text label.
 * Prefers Cambridge-style codes (0xxx / 9xxx) over arbitrary 4-digit tokens
 * so that years (`2019`, `2027`) embedded in the label don't shadow the
 * actual code. Returns the first matching code (left-to-right) or null.
 */
export function extractSyllabusCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  const cambridge = text.match(CAMBRIDGE_CODE);
  if (cambridge) return cambridge[1];
  const fallback = text.match(ANY_FOUR_DIGIT);
  return fallback ? fallback[1] : null;
}

/**
 * Light normaliser for the write side: collapses internal whitespace, trims
 * the ends, and turns empty strings into null. Crucially it preserves the
 * descriptive label ("Cambridge Syllabus · 9709") so the tutor UI keeps its
 * human-readable display — only `extractSyllabusCode` is responsible for
 * pulling the canonical code at lookup time.
 */
export function normalizeQuizSyllabusForWrite(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? null : cleaned;
}
