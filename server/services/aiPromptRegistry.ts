/**
 * Prompt version registry.
 *
 * Every system prompt we send to a provider should be tagged with a stable
 * version identifier so we can correlate quality regressions to prompt
 * changes. We DO NOT rewrite prompts here — we simply attach a version and
 * a hash so telemetry, caching, and downstream observability can use them.
 *
 * Bump the version (e.g. "soma-maker:v2") when the prompt text materially
 * changes. The hash is computed from the prompt text at registration time
 * and is the source of truth if a version label is forgotten.
 */
import { hashPayload } from "../utils/aiTelemetry";

export interface PromptDescriptor {
  id: string;
  version: string;
  hash: string;
  /** Optional default task type (used by cost guardrails). */
  taskType?: string;
}

const registry = new Map<string, PromptDescriptor>();

export function registerPrompt(id: string, version: string, text: string, taskType?: string): PromptDescriptor {
  const desc: PromptDescriptor = { id, version, hash: hashPayload(text), taskType };
  registry.set(id, desc);
  return desc;
}

export function describePrompt(id: string): PromptDescriptor | undefined {
  return registry.get(id);
}

/**
 * Wrap a prompt text with version metadata. If the prompt id is unknown we
 * synthesise a descriptor on the fly using the hash so callers always get
 * SOMETHING to record in telemetry.
 */
export function withPromptVersion(id: string, version: string | undefined, text: string, taskType?: string): { text: string; descriptor: PromptDescriptor } {
  const existing = registry.get(id);
  if (existing) return { text, descriptor: existing };
  const descriptor = registerPrompt(id, version ?? "v1", text, taskType);
  return { text, descriptor };
}

// ─── Built-in registrations ────────────────────────────────────────────────
// Stable IDs for the prompts that already exist in the codebase. The version
// label captures the SOMA pipeline behaviour at the time of this commit; bump
// when the prompt template changes.
export const PromptIds = {
  SOMA_MAKER: "soma.maker",
  SOMA_VERIFIER: "soma.verifier",
  COPILOT_SYSTEM: "copilot.system",
  COPILOT_GRAPH_RETRY: "copilot.graph_retry",
  TUTOR_GRADER: "tutor.grader",
  TOPIC_INVENTORY: "topic.inventory",
} as const;

registerPrompt(PromptIds.SOMA_MAKER, "v1", "SOMA question maker — generate MCQ draft", "generation");
registerPrompt(PromptIds.SOMA_VERIFIER, "v1", "SOMA question verifier — Soma tutor voice", "verification");
registerPrompt(PromptIds.COPILOT_SYSTEM, "v1", "Tutor copilot system prompt", "chat");
registerPrompt(PromptIds.COPILOT_GRAPH_RETRY, "v1", "Tutor copilot graph retry", "chat");
registerPrompt(PromptIds.TUTOR_GRADER, "v1", "Tutor free-response grader", "grading");
registerPrompt(PromptIds.TOPIC_INVENTORY, "v1", "Topic inventory extraction", "extraction");
