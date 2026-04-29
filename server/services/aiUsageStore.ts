/**
 * Postgres adapter for AI telemetry.
 *
 * Subscribes to the same envelope `aiUsageMetrics.record()` consumes, but
 * persists rows into `ai_usage_logs` for historical reporting (super-admin
 * spend dashboard).
 *
 * Design rules:
 *   1. **Non-blocking**: every persist is fire-and-forget. We never await
 *      the insert from the call path.
 *   2. **Failure-isolated**: a DB hiccup must never bubble up into AI calls.
 *      All errors are caught and logged once; further inserts continue.
 *   3. **Privacy**: only counters + safe metadata. No prompt, no response,
 *      no idempotency key.
 *   4. **No-op when DB is absent**: if `db` is null (in-memory mode, tests),
 *      we silently skip.
 */
import { db } from "../db";
import { aiUsageLogs } from "@shared/schema";

export interface PersistInput {
  requestId?: string | null;
  parentRequestId?: string | null;
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

let warned = false;

function microUsdFromUsd(usd: number | null): number | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  return Math.round(usd * 1_000_000);
}

/**
 * Validate that a string looks like a UUID. The aiUsageLogs.userId column is a
 * Postgres `uuid`, so any non-uuid value (e.g. `"unknown"`, an admin label)
 * would error on insert. We coerce to null when in doubt.
 */
function asUuidOrNull(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  return /^[0-9a-fA-F-]{36}$/.test(value) ? value : null;
}

/**
 * Best-effort persist — never throws.
 */
export function persist(input: PersistInput): void {
  if (!db) return;
  void (async () => {
    try {
      await db!.insert(aiUsageLogs).values({
        requestId: input.requestId ?? null,
        parentRequestId: input.parentRequestId ?? null,
        provider: input.provider,
        model: input.model,
        taskType: input.taskType ?? null,
        promptVersion: input.promptVersion ?? null,
        route: input.route ?? null,
        userId: asUuidOrNull(input.userId ?? null),
        inputTokens: Math.max(0, Math.floor(input.inputTokens || 0)),
        outputTokens: Math.max(0, Math.floor(input.outputTokens || 0)),
        costMicroUsd: microUsdFromUsd(input.costUsd),
        latencyMs: Math.max(0, Math.floor(input.latencyMs || 0)),
        success: !!input.success,
        validationFailed: !!input.validationFailed,
        parseFailed: !!input.parseFailed,
        cached: !!input.cached,
        retryCount: Math.max(0, Math.floor(input.retryCount || 0)),
      });
    } catch (err: any) {
      if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn(`[aiUsageStore] persist failed (will keep trying silently): ${err?.message ?? err}`);
      }
    }
  })();
}
