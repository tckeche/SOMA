/**
 * In-memory TTL cache for AI responses.
 *
 * Used for two purposes:
 *  - Idempotency: if the SAME generation request comes in again
 *    (e.g. browser retry, queue redelivery) we return the previous result
 *    instead of paying for inference twice.
 *  - Deterministic-subflow caching: verifier passes / retrieval contexts
 *    that are stable for a given (input, prompt_version, model) tuple.
 *
 * Caching is OPT-IN per call site to avoid surprising stateful behaviour in
 * flows that legitimately need re-rolls. Keys must be supplied by the caller.
 */
import crypto from "crypto";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

const store = new Map<string, CacheEntry<any>>();
const MAX_ENTRIES = 1000;

export interface CacheKeyParts {
  inputHash: string;
  promptVersion?: string | null;
  model?: string | null;
  scope?: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  return crypto
    .createHash("sha256")
    .update(`${parts.scope ?? "default"}|${parts.inputHash}|${parts.promptVersion ?? ""}|${parts.model ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

export function get<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function set<T>(key: string, value: T, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    // Drop the oldest entry to bound memory.
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    store.forEach((v, k) => {
      if (v.createdAt < oldestAt) {
        oldestAt = v.createdAt;
        oldestKey = k;
      }
    });
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs, createdAt: Date.now() });
}

/**
 * Run `compute` if the key is not cached, otherwise return the cached value.
 * `compute` should ONLY return a result the caller is happy to replay; if it
 * throws, nothing is cached.
 */
export async function memoize<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const cached = get<T>(key);
  if (cached !== undefined) return { value: cached, hit: true };
  const value = await compute();
  set(key, value, ttlMs);
  return { value, hit: false };
}

/** Test-only. */
export function _resetCacheForTests(): void {
  store.clear();
}

export const CacheTTL = {
  IDEMPOTENCY: 10 * 60_000, // 10 min — covers retries / queue redeliveries.
  VERIFIER: 60 * 60_000, // 1 hour — verification of identical drafts is deterministic.
  RETRIEVAL: 30 * 60_000, // 30 min — retrieval contexts evolve slowly.
};
