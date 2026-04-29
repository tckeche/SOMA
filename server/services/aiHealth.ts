/**
 * Lightweight per-provider/model health tracker for circuit-breaker-style
 * health-aware routing.
 *
 * Tracks rolling success / timeout / parse-failure counts and average
 * latency. If a provider crosses the failure threshold within the rolling
 * window it is placed in cooldown and skipped by the router until the
 * cooldown expires.
 *
 * Storage is pluggable via the `HealthStore` interface so a deployment
 * with multiple server instances can plug in a shared backend (Redis,
 * Memcached, etc.) and converge on a single view of provider health
 * without forcing every instance to discover bad providers independently.
 *
 * Default backend is in-memory and zero-dependency, which is correct for
 * single-instance and dev/test setups. Set AI_HEALTH_STORE=redis (and
 * provide a Redis client via `setHealthStore`) to share state across pods.
 *
 * The breaker is disabled by default in NODE_ENV=test so unit tests retain
 * deterministic fallback ordering — set AI_CIRCUIT_BREAKER=1 to enable.
 */

const WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;
const FAILURE_THRESHOLD = 5; // failures within window before tripping
const FAILURE_RATE_THRESHOLD = 0.6; // and at least 60% of attempts failed

export type FailureKind = "timeout" | "parse" | "validation" | "other";

export interface ProviderStatsSnapshot {
  successes: number;
  failures: number;
  timeouts: number;
  parseFailures: number;
  validationFailures: number;
  latencies: number[];
  windowStart: number;
  cooldownUntil: number;
}

/**
 * HealthStore is the storage abstraction. A Redis-backed implementation
 * needs only to provide these five methods (plus the same window-rotation
 * semantics). We deliberately keep the interface synchronous for the
 * in-memory case; a Redis impl can serve from a local LRU cache that
 * subscribes to provider stats keyspace notifications, OR can be made
 * async by lifting the few callers below — both paths are open without
 * forcing an async rewrite of the orchestrator today.
 */
export interface HealthStore {
  read(key: string): ProviderStatsSnapshot | null;
  write(key: string, stats: ProviderStatsSnapshot): void;
  keys(): string[];
  clear(): void;
  /** Diagnostic name — surfaced by /super-admin metrics endpoints. */
  readonly backend: string;
}

class MemoryHealthStore implements HealthStore {
  readonly backend = "memory";
  private readonly map = new Map<string, ProviderStatsSnapshot>();
  read(key: string): ProviderStatsSnapshot | null {
    return this.map.get(key) ?? null;
  }
  write(key: string, stats: ProviderStatsSnapshot): void {
    this.map.set(key, stats);
  }
  keys(): string[] {
    const out: string[] = [];
    this.map.forEach((_v, k) => out.push(k));
    return out;
  }
  clear(): void {
    this.map.clear();
  }
}

let store: HealthStore = new MemoryHealthStore();

/**
 * Swap in a different backend (e.g. Redis-backed).
 *
 * Example skeleton for a Redis adapter (not committed — Redis isn't a
 * dependency in this project yet):
 *
 *   class RedisHealthStore implements HealthStore {
 *     readonly backend = "redis";
 *     constructor(private redis: import("ioredis").Redis, private ns = "ai:health:") {}
 *     read(key: string) {
 *       const raw = await this.redis.get(this.ns + key); // promote to async
 *       return raw ? JSON.parse(raw) : null;
 *     }
 *     write(key, stats) {
 *       this.redis.set(this.ns + key, JSON.stringify(stats), "PX", WINDOW_MS * 2);
 *     }
 *     keys() { return this.redis.keys(this.ns + "*"); }
 *     clear() { ... }
 *   }
 */
export function setHealthStore(next: HealthStore): void {
  store = next;
}

export function currentHealthBackend(): string {
  return store.backend;
}

function key(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function emptyStats(): ProviderStatsSnapshot {
  return {
    successes: 0,
    failures: 0,
    timeouts: 0,
    parseFailures: 0,
    validationFailures: 0,
    latencies: [],
    windowStart: Date.now(),
    cooldownUntil: 0,
  };
}

function getOrInit(k: string): ProviderStatsSnapshot {
  let s = store.read(k);
  if (!s) {
    s = emptyStats();
  }
  if (Date.now() - s.windowStart > WINDOW_MS) {
    const cooldownUntil = s.cooldownUntil;
    s = emptyStats();
    s.cooldownUntil = cooldownUntil; // preserve cooldown across window roll
  }
  store.write(k, s);
  return s;
}

export function recordSuccess(provider: string, model: string, latencyMs: number): void {
  const s = getOrInit(key(provider, model));
  s.successes++;
  s.latencies.push(latencyMs);
  if (s.latencies.length > 50) s.latencies.shift();
  store.write(key(provider, model), s);
}

export function recordFailure(provider: string, model: string, kind: FailureKind): void {
  const s = getOrInit(key(provider, model));
  s.failures++;
  if (kind === "timeout") s.timeouts++;
  if (kind === "parse") s.parseFailures++;
  if (kind === "validation") s.validationFailures++;
  const total = s.successes + s.failures;
  const rate = total > 0 ? s.failures / total : 0;
  if (s.failures >= FAILURE_THRESHOLD && rate >= FAILURE_RATE_THRESHOLD) {
    s.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  store.write(key(provider, model), s);
}

export function isInCooldown(provider: string, model: string): boolean {
  const s = store.read(key(provider, model));
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
  validationFailures: number;
  inCooldown: boolean;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  failureRate: number;
  timeoutRate: number;
  parseFailureRate: number;
  validationFailureRate: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function snapshot(): HealthSnapshot[] {
  const out: HealthSnapshot[] = [];
  for (const k of store.keys()) {
    const s = store.read(k);
    if (!s) continue;
    const [provider, ...rest] = k.split("/");
    const total = s.successes + s.failures;
    const sortedLatencies = [...s.latencies].sort((a, b) => a - b);
    out.push({
      provider,
      model: rest.join("/"),
      successes: s.successes,
      failures: s.failures,
      timeouts: s.timeouts,
      parseFailures: s.parseFailures,
      validationFailures: s.validationFailures,
      inCooldown: Date.now() < s.cooldownUntil,
      avgLatencyMs: s.latencies.length ? s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length : 0,
      p95LatencyMs: percentile(sortedLatencies, 95),
      successRate: total ? s.successes / total : 1,
      failureRate: total ? s.failures / total : 0,
      timeoutRate: total ? s.timeouts / total : 0,
      parseFailureRate: total ? s.parseFailures / total : 0,
      validationFailureRate: total ? s.validationFailures / total : 0,
    });
  }
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
    const aStats = store.read(key(a.c.provider, a.c.model));
    const bStats = store.read(key(b.c.provider, b.c.model));
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
  store.clear();
}

/** Test-only: reset to a fresh in-memory backend. */
export function _useMemoryStoreForTests(): void {
  store = new MemoryHealthStore();
}
