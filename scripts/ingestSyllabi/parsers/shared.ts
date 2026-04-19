/**
 * Text utilities shared across pattern parsers.
 *
 * The Cambridge PDFs are extracted with `pdftotext -layout`, so line breaks
 * roughly correspond to visual rows on the page. That preserves column
 * structure but also leaves us with page headers, "continued" banners, and
 * whitespace-rich two-column tables that need normalising before we can
 * identify topics / subtopics / bullets.
 */

export const PAGE_HEADER_PATTERNS: RegExp[] = [
  /^Back to contents page/i,
  /www\.cambridgeinternational\.org/i,
  /Cambridge (International|IGCSE).+ syllabus for \d{4}/i,
];

/**
 * Returns true for lines we should ignore outright: page headers, footers,
 * empty trailers left by pdftotext.
 */
export function isPageNoise(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return PAGE_HEADER_PATTERNS.some((rx) => rx.test(trimmed));
}

/**
 * Collapse runs of whitespace inside a statement to a single space. Used when
 * concatenating continuation lines into the canonical statement text.
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split a two-column table row into { left, right }. We use a run of 3+ spaces
 * between non-whitespace tokens as the column boundary — this matches the
 * gutter pdftotext emits for Cambridge's "Candidates should be able to …  |
 * Notes and examples" tables.
 *
 * Returns `null` when no clear split is detected so the caller can keep the
 * whole line as-is.
 */
export function splitColumns(line: string): { left: string; right: string } | null {
  const match = line.match(/^(.+?\S)(\s{3,})(\S.*)$/);
  if (!match) return null;
  return { left: match[1], right: match[3] };
}

/**
 * Slice an extracted PDF text into {marker: [linesUntilNextMarker]} buckets.
 * Each marker is described by a label + a regex that matches its header line.
 * The first marker wins if a line matches more than one regex.
 */
export interface SectionMatch<K extends string> {
  label: K;
  rx: RegExp;
}

export function sliceSections<K extends string>(
  lines: string[],
  markers: SectionMatch<K>[],
): Map<K, string[]> {
  const out = new Map<K, string[]>();
  let current: K | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const marker = markers.find((m) => m.rx.test(trimmed));
    if (marker) {
      current = marker.label;
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (current) {
      out.get(current)!.push(raw);
    }
  }
  return out;
}

/**
 * Identify the "continued" banner Cambridge inserts at the top of a topic's
 * continuation page (e.g. "1       Number continued"). These should be
 * skipped by the parsers so they don't register a second topic.
 */
export function isContinuationBanner(trimmed: string): boolean {
  return /^\d+\s+.+\bcontinued$/i.test(trimmed) || /\bcontinued\s*$/i.test(trimmed);
}

/**
 * Heuristic: does this trimmed line end a bullet / statement, i.e. ends with
 * a full stop, question mark or colon? Used when deciding whether to join a
 * continuation line into the previous statement.
 */
export function looksFinal(trimmed: string): boolean {
  return /[.!?:;]$/.test(trimmed);
}
