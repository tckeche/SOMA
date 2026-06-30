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
  narrowInventoryToSelection,
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

describe("narrowInventoryToSelection", () => {
  it("returns the full inventory when no topic selection is supplied", () => {
    expect(narrowInventoryToSelection(inventory, [], [])).toEqual(inventory);
    expect(narrowInventoryToSelection(inventory, null, null)).toEqual(inventory);
    expect(narrowInventoryToSelection(inventory, undefined, undefined)).toEqual(inventory);
  });

  it("keeps only the selected topic so an in-syllabus but off-topic tag is caught", () => {
    const narrowed = narrowInventoryToSelection(inventory, [1]); // Algebra only
    expect(narrowed.map((t) => t.topicTitle)).toEqual(["Algebra"]);
    // Calculus is in the syllabus but not requested → now flagged off_topic.
    expect(assessTopicScope("Calculus", "Differentiation", narrowed).status).toBe("off_topic");
    expect(assessTopicScope("Algebra", "Polynomials", narrowed).status).toBe("in_scope");
  });

  it("narrows subtopics when specific subtopic ids are selected", () => {
    const narrowed = narrowInventoryToSelection(inventory, [1], [11]); // Algebra / Polynomials
    expect(narrowed[0].subtopics.map((s) => s.title)).toEqual(["Polynomials"]);
    // Partial fractions is under Algebra but not selected → off_subtopic (warn only).
    expect(assessTopicScope("Algebra", "Partial fractions", narrowed).status).toBe("off_subtopic");
  });

  it("falls back to the full inventory when the selection matches no topic (never disables the gate)", () => {
    const narrowed = narrowInventoryToSelection(inventory, [9999]);
    expect(narrowed).toEqual(inventory);
  });

  it("ignores invalid ids", () => {
    expect(narrowInventoryToSelection(inventory, [0, -1, NaN])).toEqual(inventory);
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
