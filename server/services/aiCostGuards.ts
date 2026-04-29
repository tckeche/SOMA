/**
 * Cost guardrails.
 *
 * Per-task max_tokens caps so we never accidentally request 16k tokens for
 * a 200-token grading job. Anthropic in particular requires `max_tokens`
 * on every call, so a bad default there is a real cost risk.
 *
 * Caps are intentionally generous — they are a safety net, not a tuning
 * knob. Tighten them once telemetry shows actual output sizes.
 */

export type TaskType =
  | "generation"
  | "verification"
  | "grading"
  | "chat"
  | "extraction"
  | "retrieval"
  | "default";

const MAX_TOKENS: Record<TaskType, number> = {
  generation: 8_192,
  verification: 8_192,
  grading: 1_024,
  chat: 4_096,
  extraction: 4_096,
  retrieval: 2_048,
  default: 4_096,
};

export function maxTokensForTask(taskType?: string | null): number {
  if (!taskType) return MAX_TOKENS.default;
  return (MAX_TOKENS as Record<string, number>)[taskType] ?? MAX_TOKENS.default;
}

/**
 * Clamp a requested max_tokens value to the cap for the task type. Callers
 * may still request a smaller value; we only protect against runaway upper
 * bounds.
 */
export function clampMaxTokens(requested: number | undefined, taskType?: string | null): number {
  const cap = maxTokensForTask(taskType);
  if (!requested || requested <= 0) return cap;
  return Math.min(requested, cap);
}
