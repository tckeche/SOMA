/**
 * Lightweight liveness cache for the AI providers (OpenAI / Anthropic / Google).
 *
 * We deliberately avoid synthetic health pings (they cost money and add latency).
 * Instead the orchestrator calls `recordProviderResult` whenever it completes a
 * real call, and `getAIStatus()` exposes the most recent outcome per provider —
 * combined with a key-presence check for providers that have never been called
 * in this process.
 */

export type AIProvider = "openai" | "anthropic" | "google";

export type AIProviderState =
  | "ok"         // recent real call succeeded
  | "degraded"   // recent call failed with a transient error (rate limit, 5xx)
  | "down"       // recent call failed with a fatal error (auth, quota, unknown)
  | "no_key"     // API key is not configured
  | "unknown";   // key is configured but no call has happened yet

export interface AIProviderStatus {
  provider: AIProvider;
  state: AIProviderState;
  lastCheckedAt: string | null;
  note: string | null;
}

const ENV_KEYS: Record<AIProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

interface RecordedResult {
  ok: boolean;
  at: number;
  errorKind: "rate_limit" | "quota" | "auth" | "network" | "unknown" | null;
  note: string | null;
}

const recent = new Map<AIProvider, RecordedResult>();

function classifyError(err: unknown): { kind: RecordedResult["errorKind"]; note: string } {
  const message = err instanceof Error ? err.message : String(err || "");
  const lower = message.toLowerCase();
  if (/\b429\b|rate.?limit/.test(lower)) return { kind: "rate_limit", note: "Rate limited" };
  if (/quota|insufficient.?funds|credit|billing/.test(lower)) return { kind: "quota", note: "Out of credit/quota" };
  if (/401|403|unauthori[sz]ed|invalid api key|authentication/.test(lower)) return { kind: "auth", note: "Authentication error" };
  if (/fetch failed|timeout|econn|network|dns/.test(lower)) return { kind: "network", note: "Network error" };
  return { kind: "unknown", note: message.slice(0, 160) || "Unknown error" };
}

export function recordProviderResult(provider: AIProvider, ok: boolean, error?: unknown): void {
  if (ok) {
    recent.set(provider, { ok: true, at: Date.now(), errorKind: null, note: null });
    return;
  }
  const { kind, note } = classifyError(error);
  recent.set(provider, { ok: false, at: Date.now(), errorKind: kind, note });
}

function toStatus(provider: AIProvider): AIProviderStatus {
  const keyPresent = Boolean(process.env[ENV_KEYS[provider]]);
  if (!keyPresent) {
    return { provider, state: "no_key", lastCheckedAt: null, note: `${ENV_KEYS[provider]} is not set` };
  }
  const record = recent.get(provider);
  if (!record) {
    return { provider, state: "unknown", lastCheckedAt: null, note: null };
  }
  const lastCheckedAt = new Date(record.at).toISOString();
  if (record.ok) {
    return { provider, state: "ok", lastCheckedAt, note: null };
  }
  // Rate limits are temporary: surface as "degraded" (amber) rather than "down" (red).
  const state: AIProviderState = record.errorKind === "rate_limit" || record.errorKind === "network" ? "degraded" : "down";
  return { provider, state, lastCheckedAt, note: record.note };
}

export function getAIStatus(): AIProviderStatus[] {
  return (Object.keys(ENV_KEYS) as AIProvider[]).map(toStatus);
}
