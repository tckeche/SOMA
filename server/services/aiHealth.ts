/**
 * Lightweight per-provider/model health tracker for circuit-breaker-style
 * health-aware routing.
 *
 * Tracks rolling success / timeout / parse-failure counts and average
 * latency. If a provider crosses the failure threshold within the rolling
 * window it is placed in cooldown and skipped by the router until the
 * cooldown expires.
 *
 * Pure in-memory, zero external dependencies. Disabled by default in
 * NODE_ENV=test so unit tests retain deterministic fallback ordering — set
 * AI_CIRCUIT_BREAKER=1 to enable in tests if needed.
 */

interface ProviderStats {
  successes: number;
  failures: number;
  timeouts: number;
  parseFailures: number;
  latencies: number[];
  windowStart: number;
  cooldownUntil: number;
}

const WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;
const FAILURE_THRESHOLD = 5; // failures within window before tripping
const FAILURE_RATE_THRESHOLD = 0.6; // and at least 60% of attempts failed

const stats = new Map<string, ProviderStats>();

function key(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function getOrInit(k: string): ProviderStats {
  let s = stats.get(k);
  if (!s) {
    s = { successes: 0, failures: 0, timeouts: 0, parseFailures: 0, latencies: [], windowStart: Date.now(), cooldownUntil: 0 };
    stats.set(k, s);
  }
  if (Date.now() - s.windowStart > WINDOW_MS) {
    s.successes = 0;
    s.failures = 0;
    s.timeouts = 0;
    s.parseFailures = 0;
    s.latencies = [];
    s.windowStart = Date.now();
  }
  return s;
}

export function recordSuccess(provider: string, model: string, latencyMs: number): void {
  const s = getOrInit(key(provider, model));
  s.successes++;
  s.latencies.push(latencyMs);
  if (s.latencies.length > 50) s.latencies.shift();
}

export function recordFailure(provider: string, model: string, kind: "timeout" | "parse" | "other"): void {
  const s = getOrInit(key(provider, model));
  s.failures++;
  if (kind === "timeout") s.timeouts++;
  if (kind === "parse") s.parseFailures++;
  const total = s.successes + s.failures;
  const rate = total > 0 ? s.failures / total : 0;
  if (s.failures >= FAILURE_THRESHOLD && rate >= FAILURE_RATE_THRESHOLD) {
    s.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

export function isInCooldown(provider: string, model: string): boolean {
  const s = stats.get(key(provider, model));
  if (!s) return false;
  return Date.now() < s.cooldownUntil;
}

function isEnabled(): boolean {
  if (process.env.AI_CIRCUIT_BREAKER === "0") return false;
  if (process.env.NODE_ENV === "test" && process.env.AI_CIRCUIT_BREAKER !== "1") return false;
  return true;
}

export interface HealthSnapshot {
  provider: string;
  model: string;
  successes: number;
  failures: number;
  timeouts: number;
  parseFailures: number;
  inCooldown: boolean;
  avgLatencyMs: number;
  successRate: number;
}

export function snapshot(): HealthSnapshot[] {
  const out: HealthSnapshot[] = [];
  stats.forEach((s, k) => {
    const [provider, ...rest] = k.split("/");
    const total = s.successes + s.failures;
    out.push({
      provider,
      model: rest.join("/"),
      successes: s.successes,
      failures: s.failures,
      timeouts: s.timeouts,
      parseFailures: s.parseFailures,
      inCooldown: Date.now() < s.cooldownUntil,
      avgLatencyMs: s.latencies.length ? s.latencies.reduce((a: number, b: number) => a + b, 0) / s.latencies.length : 0,
      successRate: total ? s.successes / total : 1,
    });
  });
  return out;
}

/**
 * Reorder a fallback chain so that healthier providers come first while
 * preserving the original order for ties. Providers in cooldown are pushed
 * to the back rather than removed entirely (so they're still available if
 * every other provider is also down).
 */
export function reorderByHealth<T extends { provider: string; model: string }>(chain: T[]): T[] {
  if (!isEnabled()) return chain;
  const indexed = chain.map((c, idx) => ({ c, idx }));
  indexed.sort((a, b) => {
    const aDown = isInCooldown(a.c.provider, a.c.model);
    const bDown = isInCooldown(b.c.provider, b.c.model);
    if (aDown !== bDown) return aDown ? 1 : -1;
    const aStats = stats.get(key(a.c.provider, a.c.model));
    const bStats = stats.get(key(b.c.provider, b.c.model));
    const aRate = aStats && aStats.successes + aStats.failures > 0
      ? aStats.successes / (aStats.successes + aStats.failures)
      : 1;
    const bRate = bStats && bStats.successes + bStats.failures > 0
      ? bStats.successes / (bStats.successes + bStats.failures)
      : 1;
    if (Math.abs(aRate - bRate) > 0.1) return bRate - aRate;
    return a.idx - b.idx;
  });
  return indexed.map((x) => x.c);
}

/** Test-only: clear all health state. */
export function _resetHealthForTests(): void {
  stats.clear();
}
