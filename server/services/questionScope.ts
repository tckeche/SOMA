/**
 * Deterministic POST-GENERATION SCOPE GATE.
 *
 * The Maker/Verifier prompts ask the LLM to stay inside the selected
 * syllabus topic ("STRICT SCOPE: …"), but that is a soft instruction with
 * no enforcement — a drifting Maker that tags a question onto an adjacent
 * topic would ship unchecked. This module closes that gap with the same
 * closed-set discipline the examiner-misconception extractor already uses
 * (`catalogueInventory.ts`): compare the question's `topic_tag` /
 * `subtopic_tag` against the catalogue inventory for its syllabus code and
 * report whether it is in scope.
 *
 * Pure + side-effect-free. The caller loads the inventory (async DB) once
 * per batch and feeds it in, so this stays unit-testable with no I/O.
 *
 * Severity policy is intentionally conservative to avoid flooding the tutor
 * review queue with false positives:
 *   - `off_topic`    → strong off-syllabus signal → downgrade to needs_review.
 *   - `off_subtopic` → minor drift inside the right topic → warn only.
 *   - `untagged` / `uncatalogued` → cannot validate → no change.
 */
import type { AllowedTopic } from "./catalogueInventory";
import { lookupInInventory } from "./catalogueInventory";

export type ScopeStatus =
  | "in_scope" // topic (and subtopic, if tagged) found in the inventory
  | "off_topic" // topic tag present but not in the inventory
  | "off_subtopic" // topic matches but the tagged subtopic is not under it
  | "untagged" // no topic tag — nothing to validate against
  | "uncatalogued"; // inventory empty — syllabus not catalogued, cannot constrain

export interface ScopeAssessment {
  status: ScopeStatus;
  reason?: string;
}

/**
 * Classify a generated question's topic/subtopic tags against the closed-set
 * catalogue inventory for its syllabus. Returns `uncatalogued` (the safe
 * no-op) whenever the syllabus has no catalogue rows yet, mirroring the
 * extractor's "fall back to unconstrained" contract.
 */
export function assessTopicScope(
  topicTag: string | null | undefined,
  subtopicTag: string | null | undefined,
  inventory: AllowedTopic[],
): ScopeAssessment {
  if (!inventory || inventory.length === 0) return { status: "uncatalogued" };

  const topic = (topicTag ?? "").trim();
  if (!topic) return { status: "untagged" };

  const hit = lookupInInventory(inventory, topic, subtopicTag);
  if (!hit) {
    return {
      status: "off_topic",
      reason: `tagged topic "${topic}" is not in this syllabus' catalogue`,
    };
  }

  const sub = (subtopicTag ?? "").trim();
  if (sub && hit.subtopicId === null) {
    return {
      status: "off_subtopic",
      reason: `tagged subtopic "${sub}" is not under topic "${topic}" in the catalogue`,
    };
  }

  return { status: "in_scope" };
}

export type ReviewStatus = "approved" | "needs_review" | "auto_blocked";

/**
 * Narrow a full-syllabus inventory down to only the topics the tutor actually
 * selected, so the scope gate flags drift to a DIFFERENT requested topic (e.g.
 * a Calculus question in an Algebra quiz) rather than merely drift off the whole
 * syllabus. Falls back to the full inventory when no usable selection is
 * supplied — or when the selection matches no inventory topic — so the gate is
 * never silently disabled.
 */
export function narrowInventoryToSelection(
  inventory: AllowedTopic[],
  selectedTopicIds?: number[] | null,
  selectedSubtopicIds?: number[] | null,
): AllowedTopic[] {
  const topicIds = (selectedTopicIds ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (topicIds.length === 0) return inventory;

  const topicSet = new Set(topicIds);
  const subSet = new Set((selectedSubtopicIds ?? []).filter((n) => Number.isFinite(n) && n > 0));
  const narrowed = inventory
    .filter((t) => topicSet.has(t.topicId))
    .map((t) => ({
      ...t,
      // When specific subtopics were chosen, keep only those; otherwise keep
      // every subtopic under the selected topic.
      subtopics: subSet.size > 0 ? t.subtopics.filter((s) => subSet.has(s.id)) : t.subtopics,
    }));

  // If the selection matched no inventory topic (e.g. a catalogue-cut mismatch),
  // keep the full inventory rather than disabling the gate entirely.
  return narrowed.length > 0 ? narrowed : inventory;
}

export interface ReviewResolution {
  reviewStatus: ReviewStatus;
  /** Extra human-readable reasons added on top of the base quality result. */
  reasons: string[];
}

/**
 * Single source of truth for the FINAL review status persisted on a question.
 * Folds the deterministic quality gate together with the scope gate and the
 * independent-verification signal so every write path (generate, soma-generate,
 * publish) reaches the same decision.
 *
 *   - `auto_blocked` is terminal: a structurally broken question is never
 *     relaxed by scope/verification signals.
 *   - an off-syllabus topic OR an unconfirmed answer key downgrades an
 *     otherwise-approved question to `needs_review` so it never silently
 *     reaches a student (the serve gate withholds needs_review).
 *
 * `confirmed === undefined` means "no independent-verification data for this
 * write path" (e.g. the builder→publish flow) and never triggers a downgrade,
 * preserving existing behaviour for callers that cannot supply it.
 */
export function resolveReviewStatus(input: {
  baseStatus: ReviewStatus;
  scope?: ScopeAssessment;
  confirmed?: boolean;
}): ReviewResolution {
  const reasons: string[] = [];
  let status = input.baseStatus;

  if (status === "auto_blocked") {
    return { reviewStatus: status, reasons };
  }

  switch (input.scope?.status) {
    case "off_topic":
      status = "needs_review";
      reasons.push(input.scope.reason ?? "tagged topic is outside the syllabus catalogue");
      break;
    case "off_subtopic":
      // Minor drift inside the right topic — surface it but keep serving.
      reasons.push(input.scope.reason ?? "tagged subtopic is outside the selected topic");
      break;
    default:
      break;
  }

  if (input.confirmed === false) {
    if (status === "approved") status = "needs_review";
    reasons.push(
      "answer key was not independently confirmed (no math-prover or blind-solver agreement)",
    );
  }

  return { reviewStatus: status, reasons };
}
