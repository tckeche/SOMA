/**
 * Tests for adaptive model selection / escalation policy.
 */
import { describe, it, expect } from "vitest";
import { tryWithEscalation, modelChain, classifyTask } from "../server/services/aiModelPolicy";

describe("aiModelPolicy: classifyTask", () => {
  it("classifies quiz generation as high (academic / marks-bearing)", () => {
    expect(classifyTask("generation")).toBe("high");
    expect(classifyTask("quiz.generation")).toBe("high");
    expect(classifyTask("assessment.generation")).toBe("high");
  });

  it("classifies verification and grading as high", () => {
    expect(classifyTask("verification")).toBe("high");
    expect(classifyTask("grading")).toBe("high");
    expect(classifyTask("marking")).toBe("high");
  });

  it("classifies tutor chat / explanations as standard", () => {
    expect(classifyTask("chat")).toBe("standard");
    expect(classifyTask("explanation")).toBe("standard");
    expect(classifyTask("draft")).toBe("standard");
  });

  it("classifies formatting / classification / repair as low", () => {
    expect(classifyTask("formatting")).toBe("low");
    expect(classifyTask("classification")).toBe("low");
    expect(classifyTask("repair")).toBe("low");
    expect(classifyTask("retrieval")).toBe("low");
  });

  it("defaults unknown task types to standard (conservative)", () => {
    expect(classifyTask(undefined)).toBe("standard");
    expect(classifyTask(null)).toBe("standard");
    expect(classifyTask("totally-unknown")).toBe("standard");
  });

  it("forceRisk overrides the table", () => {
    expect(classifyTask("formatting", { forceRisk: "high" })).toBe("high");
  });

  it("affectsMarks always forces high", () => {
    expect(classifyTask("formatting", { affectsMarks: true })).toBe("high");
    expect(classifyTask(undefined, { affectsMarks: true })).toBe("high");
  });

  it("student-facing low-risk tasks bump to standard floor", () => {
    expect(classifyTask("formatting", { studentFacing: true })).toBe("standard");
  });

  it("does NOT downgrade a high-risk task even when surface input is short", () => {
    // Quiz generation must remain high regardless of how the call site looks.
    expect(classifyTask("generation", { studentFacing: true })).toBe("high");
  });
});

describe("aiModelPolicy: modelChain", () => {
  it("returns cheap-first for low risk", () => {
    const chain = modelChain("low");
    expect(chain[0].model).toMatch(/mini|flash/);
  });

  it("returns strong-first for high risk", () => {
    const chain = modelChain("high");
    expect(chain[0].provider).toBe("anthropic");
  });

  it("never includes a cheap/mini model in the high-risk chain", () => {
    const chain = modelChain("high");
    for (const m of chain) {
      expect(m.model).not.toMatch(/mini|flash/);
    }
  });
});

describe("aiModelPolicy: tryWithEscalation", () => {
  it("returns the first ok response without escalating", async () => {
    let attempts = 0;
    const result = await tryWithEscalation("low", async () => {
      attempts++;
      return { ok: true, value: "first" };
    });
    expect(attempts).toBe(1);
    if ("value" in result) {
      expect(result.value).toBe("first");
      expect(result.escalations).toBe(0);
    } else {
      throw new Error("expected success");
    }
  });

  it("escalates to next model when validation fails", async () => {
    let attempts = 0;
    const result = await tryWithEscalation("low", async () => {
      attempts++;
      if (attempts === 1) return { ok: false, reason: "schema fail" };
      return { ok: true, value: "second" };
    });
    expect(attempts).toBe(2);
    if ("value" in result) {
      expect(result.value).toBe("second");
      expect(result.escalations).toBe(1);
    } else {
      throw new Error("expected success after escalation");
    }
  });

  it("returns error when all models fail", async () => {
    const result = await tryWithEscalation("low", async () => ({ ok: false, reason: "always" }));
    expect("error" in result).toBe(true);
  });

  it("treats thrown errors like ok:false and continues", async () => {
    let attempts = 0;
    const result = await tryWithEscalation("low", async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return { ok: true, value: "ok" };
    });
    expect(attempts).toBe(3);
    if ("value" in result) expect(result.escalations).toBe(2);
  });
});
