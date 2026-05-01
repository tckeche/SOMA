/**
 * Temporary trace logger for the quiz-generation → publish pipeline.
 *
 * Sprinkled at every meaningful waypoint between the route handler
 * and the SQL INSERT so a single quiz creation produces a step-by-step
 * record of exactly which functions ran, what they received, and what
 * they wrote. Used to diagnose silent data loss between layers — the
 * pattern we have been chasing for hours where data exists at one
 * step and is NULL by the next, with nothing failing in between.
 *
 * Gated by the `QUIZ_TRACE` env var. When unset, every call is a
 * no-op (one comparison + early return) so it costs nothing in
 * production. Set `QUIZ_TRACE=1` in Replit secrets, generate one quiz,
 * then read the logs — the truth will be in the trace, in order.
 *
 * Output format: a single log line per event,
 *   [QUIZ_TRACE] <ISO_TIMESTAMP> trace=<id> event=<name> | <JSON>
 * This survives Replit's deployment log panel and is easy to grep.
 *
 * To remove this logger after the diagnosis is done: search for
 * "QUIZ_TRACE" across the codebase and delete every reference. The
 * import sites are all behind the gate so removing the instrumentation
 * is a mechanical cleanup with no behavioural impact.
 */

const ENABLED = process.env.QUIZ_TRACE === "1" || process.env.QUIZ_TRACE === "true";

/** Pads short bursts of randomness with a counter so concurrent
 *  events still get unique ids even when Date.now() collides. */
let counter = 0;
export function newTraceId(): string {
  counter = (counter + 1) % 100_000;
  return `${Date.now().toString(36)}-${counter.toString(36).padStart(4, "0")}`;
}

function safeStringify(data: unknown): string {
  try {
    // Limit payload to keep log lines parseable.
    return JSON.stringify(data, (_k, v) => {
      if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
      return v;
    });
  } catch {
    return "<unserialisable>";
  }
}

/**
 * Emit one trace event. Pass a stable `traceId` (from `newTraceId()`
 * at the route entry) so events from the same request can be grouped
 * after the fact. `data` is freeform — include whatever helps; the
 * stringifier truncates long strings and tolerates cycles.
 */
export function traceLog(
  event: string,
  data: Record<string, unknown>,
  traceId?: string,
): void {
  if (!ENABLED) return;
  const line = `[QUIZ_TRACE] ${new Date().toISOString()} trace=${traceId ?? "-"} event=${event} | ${safeStringify(data)}`;
  // eslint-disable-next-line no-console
  console.log(line);
}

/** Convenience: counts how many of the items in `arr` have a non-null,
 *  non-empty value at `key`. Useful for "how many rows have FK populated"
 *  questions without dumping the full array into the log. */
export function countWithField<T extends Record<string, unknown>>(arr: T[], key: keyof T): number {
  return arr.filter((row) => {
    const v = row[key];
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.length > 0;
    return true;
  }).length;
}

/** Returns true when QUIZ_TRACE is on — handy for guarding more
 *  expensive instrumentation paths (computing summaries, peeking
 *  at returned rows, etc.) so they only run when tracing is enabled. */
export function isTracing(): boolean {
  return ENABLED;
}
