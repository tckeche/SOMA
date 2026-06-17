/**
 * POST-GENERATION SCOPE GATE.
 *
 * Pins the closed-set scope classifier and the review-status resolver that
 * together stop off-syllabus / unverified questions from silently reaching
 * students. The maker prompt only *asks* the LLM to stay in scope; this gate
 * is the deterministic enforcement that was previously missing.
 */
import { describe, it, expect } from "vitest";

import {
  assessTopicScope,
  resolveReviewStatus,
} from "../server/services/questionScope";
import type { AllowedTopic } from "../server/services/catalogueInventory";

const inventory: AllowedTopic[] = [
  {
    topicId: 1,
    topicTitle: "Algebra",
    subtopics: [
      { id: 11, title: "Polynomials" },
      { id: 12, title: "Partial fractions" },
    ],
  },
  {
    topicId: 2,
    topicTitle: "Calculus",
    subtopics: [{ id: 21, title: "Differentiation" }],
  },
];

describe("assessTopicScope", () => {
  it("returns uncatalogued (no-op) when the inventory is empty", () => {
    expect(assessTopicScope("Algebra", "Polynomials", []).status).toBe("uncatalogued");
  });

  it("returns untagged when no topic tag is present", () => {
    expect(assessTopicScope(null, "Polynomials", inventory).status).toBe("untagged");
    expect(assessTopicScope("   ", null, inventory).status).toBe("untagged");
  });

  it("returns in_scope for a matching topic (case/space-insensitive)", () => {
    expect(assessTopicScope("algebra", "polynomials", inventory).status).toBe("in_scope");
    expect(assessTopicScope("  Calculus ", "Differentiation", inventory).status).toBe("in_scope");
  });

  it("returns in_scope for a matching topic with no subtopic tag", () => {
    expect(assessTopicScope("Algebra", null, inventory).status).toBe("in_scope");
  });

  it("flags off_topic when the topic tag is not in the inventory", () => {
    const r = assessTopicScope("Trigonometry", "Identities", inventory);
    expect(r.status).toBe("off_topic");
    expect(r.reason).toMatch(/Trigonometry/);
  });

  it("flags off_subtopic when the topic matches but the subtopic does not", () => {
    const r = assessTopicScope("Algebra", "Vectors", inventory);
    expect(r.status).toBe("off_subtopic");
    expect(r.reason).toMatch(/Vectors/);
  });
});

describe("resolveReviewStatus", () => {
  it("keeps an approved question approved when in scope and confirmed", () => {
    const r = resolveReviewStatus({
      baseStatus: "approved",
      scope: { status: "in_scope" },
      confirmed: true,
    });
    expect(r.reviewStatus).toBe("approved");
    expect(r.reasons).toHaveLength(0);
  });

  it("never relaxes an auto_blocked question", () => {
    const r = resolveReviewStatus({
      baseStatus: "auto_blocked",
      scope: { status: "in_scope" },
      confirmed: true,
    });
    expect(r.reviewStatus).toBe("auto_blocked");
  });

  it("downgrades an approved off-topic question to needs_review", () => {
    const r = resolveReviewStatus({
      baseStatus: "approved",
      scope: { status: "off_topic", reason: "tagged topic \"X\" is not in this syllabus' catalogue" },
    });
    expect(r.reviewStatus).toBe("needs_review");
    expect(r.reasons[0]).toMatch(/not in this syllabus/);
  });

  it("downgrades an approved but unconfirmed question to needs_review", () => {
    const r = resolveReviewStatus({
      baseStatus: "approved",
      scope: { status: "in_scope" },
      confirmed: false,
    });
    expect(r.reviewStatus).toBe("needs_review");
    expect(r.reasons[0]).toMatch(/not independently confirmed/);
  });

  it("does NOT downgrade when confirmation is unknown (undefined)", () => {
    const r = resolveReviewStatus({
      baseStatus: "approved",
      scope: { status: "in_scope" },
      confirmed: undefined,
    });
    expect(r.reviewStatus).toBe("approved");
  });

  it("surfaces off_subtopic as a reason but keeps serving (warn-only)", () => {
    const r = resolveReviewStatus({
      baseStatus: "approved",
      scope: { status: "off_subtopic", reason: "subtopic drift" },
      confirmed: true,
    });
    expect(r.reviewStatus).toBe("approved");
    expect(r.reasons).toContain("subtopic drift");
  });

  it("keeps an existing needs_review status when scope is clean", () => {
    const r = resolveReviewStatus({
      baseStatus: "needs_review",
      scope: { status: "in_scope" },
      confirmed: true,
    });
    expect(r.reviewStatus).toBe("needs_review");
  });
});
