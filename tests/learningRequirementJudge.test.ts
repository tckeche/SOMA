/**
 * Unit tests — `judgeBestRequirement` LLM-judge contract.
 *
 * Drives a stubbed AI call (no real API spend) and verifies:
 *   - happy-path: judge returns a valid id from the candidate set →
 *     committed, with the model's confidence + reason carried through.
 *   - judge returns null id → skipped as judge_picked_none.
 *   - judge returns id NOT in the candidate set → skipped as
 *     judge_invalid_id (defends against the model hallucinating a
 *     plausible-looking integer that isn't a real requirement id).
 *   - judge returns confidence below the floor → skipped as
 *     judge_low_confidence.
 *   - judge returns unparseable JSON → skipped as judge_invalid_id
 *     (defensive — model with json_object mode shouldn't, but providers
 *     occasionally drop schema enforcement under load).
 *   - empty candidate list → no AI call, returns judge_picked_none.
 */
import { describe, it, expect, vi } from "vitest";
import { judgeBestRequirement } from "../server/services/learningRequirementResolver";
import type { AIResult } from "../server/services/aiOrchestrator";

const META = {
  provider: "openai",
  model: "gpt-4o-mini",
  durationMs: 12,
};

function stubAIReturning(payload: unknown): {
  callAI: (
    sys: string,
    user: string,
    schema?: unknown,
    options?: unknown,
  ) => Promise<AIResult>;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => ({
    data: typeof payload === "string" ? payload : JSON.stringify(payload),
    metadata: META,
  })) as unknown as (
    sys: string,
    user: string,
    schema?: unknown,
    options?: unknown,
  ) => Promise<AIResult>;
  return { callAI: spy, spy: spy as unknown as ReturnType<typeof vi.fn> };
}

const PARTS = {
  misconception: "Student writes 2x = 7 then x = 7",
  studentError: "fails to divide both sides",
  correctApproach: "divide both sides by 2",
};

const CANDIDATES = [
  { id: 11, statement: "Solve linear equations in one variable" },
  { id: 22, statement: "Factorise quadratic expressions" },
  { id: 33, statement: "Add and subtract fractions" },
];

describe("judgeBestRequirement — LLM judge", () => {
  it("commits the match when the judge returns a valid id with sufficient confidence", async () => {
    const { callAI, spy } = stubAIReturning({
      id: 11,
      confidence: "high",
      reason: "describes solving a linear equation",
    });

    const r = await judgeBestRequirement(PARTS, CANDIDATES, /*rowId*/ 999, { callAI });

    expect(r.requirementId).toBe(11);
    expect(r.confidence).toBe("high");
    expect(r.rejectionReason).toBeNull();

    // AI call shape: idempotency key derived from rowId, taskType set
    // for cost guards, and JSON schema passed through.
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0];
    expect(callArgs[3]).toMatchObject({
      idempotencyKey: expect.stringContaining("999"),
      taskType: "misconception_classify",
      cacheable: true,
    });
  });

  it("skips with judge_picked_none when the judge returns id=null", async () => {
    const { callAI } = stubAIReturning({
      id: null,
      confidence: "high",
      reason: "no candidate fits",
    });

    const r = await judgeBestRequirement(PARTS, CANDIDATES, 1, { callAI });

    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("judge_picked_none");
    expect(r.reason).toContain("no candidate");
  });

  it("skips with judge_invalid_id when the judge returns an id NOT in the candidate set", async () => {
    const { callAI } = stubAIReturning({
      id: 99999, // not in CANDIDATES — defends against hallucinated ids
      confidence: "high",
      reason: "looks like a perfect match (but isn't real)",
    });

    const r = await judgeBestRequirement(PARTS, CANDIDATES, 1, { callAI });

    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("judge_invalid_id");
  });

  it("skips with judge_low_confidence when judge confidence is below the minConfidence floor", async () => {
    const { callAI } = stubAIReturning({
      id: 11,
      confidence: "low",
      reason: "could be linear or fractions",
    });

    const r = await judgeBestRequirement(PARTS, CANDIDATES, 1, { callAI, minConfidence: "medium" });

    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("judge_low_confidence");
    expect(r.confidence).toBe("low");
  });

  it("commits a 'low' confidence match when minConfidence is set to 'low'", async () => {
    const { callAI } = stubAIReturning({
      id: 11,
      confidence: "low",
      reason: "best of a bad bunch",
    });

    const r = await judgeBestRequirement(PARTS, CANDIDATES, 1, { callAI, minConfidence: "low" });

    expect(r.requirementId).toBe(11);
    expect(r.rejectionReason).toBeNull();
  });

  it("returns judge_picked_none without calling the AI when candidate list is empty", async () => {
    const { callAI, spy } = stubAIReturning({ id: 1, confidence: "high", reason: "x" });

    const r = await judgeBestRequirement(PARTS, [], 1, { callAI });

    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("judge_picked_none");
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips with judge_invalid_id when the AI returns unparseable JSON", async () => {
    const { callAI } = stubAIReturning("this is not json at all");

    const r = await judgeBestRequirement(PARTS, CANDIDATES, 1, { callAI });

    expect(r.requirementId).toBeNull();
    expect(r.rejectionReason).toBe("judge_invalid_id");
    expect(r.reason).toContain("unparseable");
  });

  it("clamps an unknown confidence string to 'low' and treats it as below the medium floor", async () => {
    const { callAI } = stubAIReturning({
      id: 11,
      confidence: "moderate", // not in the enum
      reason: "x",
    });

    const r = await judgeBestRequirement(PARTS, CANDIDATES, 1, { callAI, minConfidence: "medium" });

    expect(r.requirementId).toBeNull();
    expect(r.confidence).toBe("low");
    expect(r.rejectionReason).toBe("judge_low_confidence");
  });
});
