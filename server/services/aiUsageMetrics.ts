/**
 * AI usage / cost aggregator.
 *
 * Subscribes to the AI telemetry envelope and maintains rolling, in-memory
 * counters along several dimensions (provider, model, route, task type,
 * user). The aggregator is the data source for the Super Admin AI Usage
 * dashboard.
 *
 * Storage policy
 * ──────────────
 * We do NOT persist raw prompts or raw model output. The aggregator only
 * accumulates numeric counters and a small set of safe metadata fields
 * (provider, model, task_type, prompt_version, route, latency, tokens,
 * cost_usd, success/failure). This is the "minimal persistence layer
 * for AI telemetry summaries" — sized for in-memory use today, but with
 * a clean read API so a Postgres adapter can be added later without
 * touching call sites.
 *
 * Multi-instance note
 * ───────────────────
 * Like the health tracker, this aggregator runs per-process. For
 * multi-pod deployments the same `setMetricsStore` pattern used in
 * aiHealth.ts can be applied here later. Until then each pod exposes
 * its own slice and the dashboard either picks a leader or sums the
 * per-pod responses.
 */

export interface UsageRecordInput {
  provider: string;
  model: string;
  taskType?: string | null;
  promptVersion?: string | null;
  route?: string | null;
  userId?: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  success: boolean;
  validationFailed: boolean;
  parseFailed: boolean;
  cached: boolean;
  retryCount: number;
}

interface Bucket {
  calls: number;
  successes: number;
  failures: number;
  validationFailures: number;
  parseFailures: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencies: number[];
  cachedHits: number;
}

function emptyBucket(): Bucket {
  return {
    calls: 0,
    successes: 0,
    failures: 0,
    validationFailures: 0,
    parseFailures: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencies: [],
    cachedHits: 0,
  };
}

function addToBucket(b: Bucket, r: UsageRecordInput): void {
  b.calls++;
  if (r.success) b.successes++;
  else b.failures++;
  if (r.validationFailed) b.validationFailures++;
  if (r.parseFailed) b.parseFailures++;
  if (r.retryCount > 0) b.fallbacks++;
  if (r.cached) b.cachedHits++;
  b.inputTokens += r.inputTokens || 0;
  b.outputTokens += r.outputTokens || 0;
  b.costUsd += r.costUsd ?? 0;
  if (typeof r.latencyMs === "number") {
    b.latencies.push(r.latencyMs);
    if (b.latencies.length > 500) b.latencies.shift();
  }
}

const MAX_KEYS_PER_DIM = 1000;
const dims = {
  provider: new Map<string, Bucket>(),
  model: new Map<string, Bucket>(),
  taskType: new Map<string, Bucket>(),
  promptVersion: new Map<string, Bucket>(),
  route: new Map<string, Bucket>(),
  user: new Map<string, Bucket>(),
};
const overall: Bucket = emptyBucket();

function bucketFor(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    if (map.size >= MAX_KEYS_PER_DIM) {
      // Evict the smallest bucket to bound memory.
      let smallestKey: string | undefined;
      let smallestCalls = Infinity;
      map.forEach((v, k) => {
        if (v.calls < smallestCalls) { smallestCalls = v.calls; smallestKey = k; }
      });
      if (smallestKey) map.delete(smallestKey);
    }
    b = emptyBucket();
    map.set(key, b);
  }
  return b;
}

export function record(input: UsageRecordInput): void {
  addToBucket(overall, input);
  addToBucket(bucketFor(dims.provider, input.provider), input);
  addToBucket(bucketFor(dims.model, `${input.provider}/${input.model}`), input);
  if (input.taskType) addToBucket(bucketFor(dims.taskType, input.taskType), input);
  if (input.promptVersion) addToBucket(bucketFor(dims.promptVersion, input.promptVersion), input);
  if (input.route) addToBucket(bucketFor(dims.route, input.route), input);
  if (input.userId) addToBucket(bucketFor(dims.user, input.userId), input);
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

export interface DimensionRow {
  key: string;
  calls: number;
  successes: number;
  failures: number;
  validationFailures: number;
  parseFailures: number;
  fallbacks: number;
  cachedHits: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  failureRate: number;
}

function rowFromBucket(key: string, b: Bucket): DimensionRow {
  const sorted = [...b.latencies].sort((a, c) => a - c);
  return {
    key,
    calls: b.calls,
    successes: b.successes,
    failures: b.failures,
    validationFailures: b.validationFailures,
    parseFailures: b.parseFailures,
    fallbacks: b.fallbacks,
    cachedHits: b.cachedHits,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    costUsd: Number(b.costUsd.toFixed(6)),
    avgLatencyMs: b.latencies.length ? Math.round(b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length) : 0,
    p95LatencyMs: Math.round(percentile(sorted, 95)),
    failureRate: b.calls ? b.failures / b.calls : 0,
  };
}

function dump(map: Map<string, Bucket>): DimensionRow[] {
  const out: DimensionRow[] = [];
  map.forEach((b, k) => out.push(rowFromBucket(k, b)));
  out.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  return out;
}

export interface UsageReport {
  generatedAt: string;
  overall: DimensionRow;
  byProvider: DimensionRow[];
  byModel: DimensionRow[];
  byTaskType: DimensionRow[];
  byPromptVersion: DimensionRow[];
  byRoute: DimensionRow[];
  byUser: DimensionRow[];
}

export function report(): UsageReport {
  return {
    generatedAt: new Date().toISOString(),
    overall: rowFromBucket("overall", overall),
    byProvider: dump(dims.provider),
    byModel: dump(dims.model),
    byTaskType: dump(dims.taskType),
    byPromptVersion: dump(dims.promptVersion),
    byRoute: dump(dims.route),
    byUser: dump(dims.user),
  };
}

export function _resetMetricsForTests(): void {
  Object.assign(overall, emptyBucket());
  for (const k of Object.keys(dims) as (keyof typeof dims)[]) dims[k].clear();
}
