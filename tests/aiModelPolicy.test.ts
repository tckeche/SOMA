/**
 * Tests for adaptive model selection / escalation policy.
 */
import { describe, it, expect } from "vitest";
import { tryWithEscalation, modelChain } from "../server/services/aiModelPolicy";

describe("aiModelPolicy: modelChain", () => {
  it("returns cheap-first for low risk", () => {
    const chain = modelChain("low");
    expect(chain[0].model).toMatch(/mini|flash/);
  });

  it("returns strong-first for high risk", () => {
    const chain = modelChain("high");
    expect(chain[0].provider).toBe("anthropic");
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
