/**
 * Cost guardrails.
 *
 * Per-task max_tokens caps so we never accidentally request runaway output
 * sizes for short jobs. Anthropic in particular requires `max_tokens` on
 * every call, so a bad default there is a real cost risk.
 *
 * Policy:
 *  - Generation tasks (quiz/assessment authoring, long-form content) need
 *    a HIGH cap so 20–30 question quizzes are not silently truncated.
 *    Empirically a 30Q SOMA quiz with explanations runs ~12k tokens; we
 *    cap at 20k to give meaningful headroom while still bounding worst
 *    case spend.
 *  - All other task types stay tightly capped: a verifier doesn't need
 *    20k tokens to hand back a fixed-size critique, and a grader certainly
 *    doesn't.
 *
 * Tighten individual caps once telemetry shows actual output sizes for
 * each task type — these values are the safety net, not the target.
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
  // Long-form authoring. Must comfortably fit 20–30 quiz questions with
  // Soma-voice explanations. Telemetry shows ~12k for a 30Q quiz; 20k
  // headroom keeps us out of silent-truncation territory.
  generation: 20_000,

  // Verifier returns a corrected version of the input plus warnings —
  // bounded in size by the input draft, not by free-form generation.
  verification: 8_192,

  // Free-response grading: a few hundred tokens of feedback, never more.
  grading: 1_024,

  // Tutor copilot chat: medium-form pedagogical replies.
  chat: 4_096,

  // Pulling structured fields out of source material — bounded by source size.
  extraction: 4_096,

  // Retrieval / context summarisation — short by design.
  retrieval: 2_048,

  // Fallback for unclassified callers.
  default: 4_096,
};

export function maxTokensForTask(taskType?: string | null): number {
  if (!taskType) return MAX_TOKENS.default;
  return (MAX_TOKENS as Record<string, number>)[taskType] ?? MAX_TOKENS.default;
}

/**
 * Clamp a requested max_tokens value to the cap for the task type. Callers
 * may still request a smaller value; we only protect against runaway upper
 * bounds. Returning the cap when no value is supplied keeps Anthropic
 * happy (it requires max_tokens) without forcing every call site to
 * remember the limit.
 */
export function clampMaxTokens(requested: number | undefined, taskType?: string | null): number {
  const cap = maxTokensForTask(taskType);
  if (!requested || requested <= 0) return cap;
  return Math.min(requested, cap);
}

/** Read-only snapshot of the cap table — used by admin diagnostics. */
export function maxTokensTable(): Record<TaskType, number> {
  return { ...MAX_TOKENS };
}

