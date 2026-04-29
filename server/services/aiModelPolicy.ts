/**
 * Adaptive model selection policy.
 *
 * Cheap models handle low-risk subflows by default; if the contract gate
 * rejects their output, the caller escalates to the stronger model. This
 * keeps cost low on the happy path without sacrificing correctness when
 * the cheap model gets it wrong.
 *
 * Risk classes
 * ────────────
 *  - low      : formatting, simple classification, short helper ops,
 *               JSON-shape repair, retrieval summarisation. Cheap-first.
 *  - standard : ordinary tutor explanations, small draft generation,
 *               non-critical feedback. Mid-tier first.
 *  - high     : ANY task with academic consequences — quiz/assessment
 *               generation, free-response grading, student-facing
 *               educational content, long-form generation, anything
 *               whose output is a "mark" or a fact a student will rely on.
 *               Strong model first; escalation still allowed for resilience.
 *
 * IMPORTANT: quiz generation in SOMA is treated as high-risk regardless
 * of input length. A short topic prompt produces a long graded artefact;
 * the surface size is not a proxy for risk.
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
    // Strong models only. We pair Anthropic + OpenAI so an outage on one
    // still leaves us a high-quality option without dropping to a flash
    // model. We deliberately do NOT include the cheap tier in this chain.
    { provider: "anthropic", model: "claude-sonnet-4-6" },
    { provider: "openai", model: "gpt-4o" },
  ],
};

export function modelChain(risk: RiskClass): ModelChoice[] {
  return POLICY[risk];
}

/**
 * Map a task type (and optional context) to a risk class.
 *
 * The mapping is intentionally explicit and conservative — when in doubt
 * the task is treated as standard. Anything that affects a student's
 * grade or facts they'll trust must be high-risk.
 */
export interface ClassifyContext {
  /** Caller-provided risk override. Wins over the task-type default. */
  forceRisk?: RiskClass;
  /** True when the result will be shown to a student. Bumps risk floor to standard. */
  studentFacing?: boolean;
  /** True for grading / marking flows. Forces high. */
  affectsMarks?: boolean;
}

const TASK_RISK: Record<string, RiskClass> = {
  // Authoring / academic outputs — strong model first, no cheap escalation.
  generation: "high",
  "quiz.generation": "high",
  "assessment.generation": "high",
  verification: "high",
  grading: "high",
  marking: "high",

  // Pedagogical replies — mid-tier first; escalation OK.
  chat: "standard",
  "tutor.chat": "standard",
  "copilot.chat": "standard",
  explanation: "standard",
  feedback: "standard",
  draft: "standard",

  // Bounded helpers — cheap-first.
  formatting: "low",
  classification: "low",
  repair: "low",
  retrieval: "low",
  extraction: "low",
};

export function classifyTask(taskType?: string | null, ctx?: ClassifyContext): RiskClass {
  if (ctx?.forceRisk) return ctx.forceRisk;
  if (ctx?.affectsMarks) return "high";
  const base: RiskClass = (taskType && TASK_RISK[taskType]) || "standard";
  if (ctx?.studentFacing && base === "low") return "standard";
  return base;
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
