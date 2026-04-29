/**
 * Adaptive model selection policy.
 *
 * Cheap models handle low-risk subflows by default; if the contract gate
 * rejects their output, the caller escalates to the stronger model. This
 * keeps cost low on the happy path without sacrificing correctness when
 * the cheap model gets it wrong.
 *
 * The policy is intentionally tiny: a static map from task-risk class to
 * an ordered list of (provider, model) tuples. Logic stays in the call
 * sites that opt in — we don't want a hidden global routing layer.
 */
export type RiskClass = "low" | "standard" | "high";

export interface ModelChoice {
  provider: "openai" | "anthropic" | "google" | "deepseek";
  model: string;
}

const POLICY: Record<RiskClass, ModelChoice[]> = {
  low: [
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "google", model: "gemini-2.5-flash" },
    { provider: "openai", model: "gpt-4o" },
  ],
  standard: [
    { provider: "openai", model: "gpt-4o" },
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "google", model: "gemini-2.5-flash" },
  ],
  high: [
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "openai", model: "gpt-4o" },
  ],
};

export function modelChain(risk: RiskClass): ModelChoice[] {
  return POLICY[risk];
}

/**
 * Helper for callers that want to "try cheap first, escalate on validation
 * failure". The provided `attempt` function is invoked per model in order;
 * if it throws OR returns `{ ok: false }`, we move to the next. The first
 * `{ ok: true, value }` wins.
 */
export async function tryWithEscalation<T>(
  risk: RiskClass,
  attempt: (choice: ModelChoice) => Promise<{ ok: true; value: T } | { ok: false; reason: string }>,
): Promise<{ value: T; chosen: ModelChoice; escalations: number } | { error: string }> {
  let escalations = 0;
  let lastReason = "no models attempted";
  for (const choice of POLICY[risk]) {
    try {
      const result = await attempt(choice);
      if (result.ok) return { value: result.value, chosen: choice, escalations };
      lastReason = result.reason;
    } catch (e: any) {
      lastReason = e?.message || String(e);
    }
    escalations++;
  }
  return { error: lastReason };
}
