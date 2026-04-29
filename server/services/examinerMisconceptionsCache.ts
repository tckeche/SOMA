/**
 * In-memory cache for examiner-misconception reads.
 *
 * Keyed by `${board}|${syllabusCode}|${subject ?? "*"}` (lowercased) so the
 * student-tips endpoint can serve repeat hits without touching Postgres.
 * TTL is 10 minutes; explicit invalidation runs from
 * `storage.createExaminerMisconceptions` so a fresh ingestion run drops
 * stale entries immediately.
 *
 * Topic-level filtering happens in-memory after cache lookup to keep the
 * cache grain at (board, syllabusCode, subject) — that's the grain the
 * UI actually queries on, and it stays small enough to scan.
 */
import type { ExaminerMisconception } from "@shared/schema";

const TTL_MS = 10 * 60 * 1000;

interface Entry {
  rows: ExaminerMisconception[];
  expiresAt: number;
}

const cache = new Map<string, Entry>();

export interface CacheFilter {
  board?: string;
  syllabusCode?: string;
  subject?: string;
  topic?: string;
}

function lower(value: string | undefined): string {
  return (value ?? "*").toLowerCase();
}

function cacheKey(filter: CacheFilter): string {
  return `${lower(filter.board)}|${lower(filter.syllabusCode)}|${lower(filter.subject)}`;
}

function applyTopicFilter(
  rows: ExaminerMisconception[],
  topic: string | undefined,
): ExaminerMisconception[] {
  if (!topic) return rows;
  const t = topic.toLowerCase();
  return rows.filter((r) => (r.topic ?? "").toLowerCase() === t);
}

/**
 * Look up cached rows or run the fetcher. Returns the rows plus diagnostic
 * timing info; callers can use the `cacheHit` boolean for logging.
 */
export async function cachedListExaminerMisconceptions(
  filter: CacheFilter,
  fetcher: () => Promise<ExaminerMisconception[]>,
): Promise<{ rows: ExaminerMisconception[]; cacheHit: boolean; ms: number }> {
  const key = cacheKey(filter);
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    const start = performance.now();
    const rows = applyTopicFilter(hit.rows, filter.topic);
    return { rows, cacheHit: true, ms: performance.now() - start };
  }

  const start = performance.now();
  const fresh = await fetcher();
  cache.set(key, { rows: fresh, expiresAt: now + TTL_MS });
  const rows = applyTopicFilter(fresh, filter.topic);
  return { rows, cacheHit: false, ms: performance.now() - start };
}

/**
 * Drop any cache entries that overlap a freshly-inserted batch. Pass the
 * board + syllabusCode of the inserted rows (subject is wildcarded so any
 * subject-filtered entry under that syllabus is invalidated too).
 */
export function invalidateExaminerMisconceptionsCache(
  filter?: { board?: string; syllabusCode?: string },
): void {
  if (!filter) {
    cache.clear();
    return;
  }
  const prefix = `${lower(filter.board)}|${lower(filter.syllabusCode)}|`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** For tests / diagnostics. */
export function _resetExaminerMisconceptionsCache(): void {
  cache.clear();
}

export function _getExaminerMisconceptionsCacheSize(): number {
  return cache.size;
}
