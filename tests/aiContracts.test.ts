/**
 * Tests for the JSON contract validation gate.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { validateAgainstSchema, repairJsonString, tryParseJson } from "../server/services/aiContracts";

const schema = z.object({ question: z.string(), answer: z.number() });

describe("aiContracts: tryParseJson", () => {
  it("parses valid JSON", () => {
    const r = tryParseJson('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
  });

  it("reports error on invalid JSON", () => {
    const r = tryParseJson("not json");
    expect(r.ok).toBe(false);
  });
});

describe("aiContracts: repairJsonString", () => {
  it("strips markdown code fences", () => {
    const repaired = repairJsonString('```json\n{"a":1}\n```');
    expect(JSON.parse(repaired)).toEqual({ a: 1 });
  });

  it("removes prose before the JSON object", () => {
    const repaired = repairJsonString('Here is the answer: {"a":1}');
    expect(JSON.parse(repaired)).toEqual({ a: 1 });
  });

  it("removes prose after the JSON object", () => {
    const repaired = repairJsonString('{"a":1}\n\nHope that helps!');
    expect(JSON.parse(repaired)).toEqual({ a: 1 });
  });

  it("strips trailing commas", () => {
    const repaired = repairJsonString('{"a":1,}');
    expect(JSON.parse(repaired)).toEqual({ a: 1 });
  });
});

describe("aiContracts: validateAgainstSchema", () => {
  it("passes for valid JSON matching schema", () => {
    const r = validateAgainstSchema('{"question":"q","answer":42}', schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ question: "q", answer: 42 });
  });

  it("repairs and passes when JSON is wrapped in code fences", () => {
    const r = validateAgainstSchema('```json\n{"question":"q","answer":42}\n```', schema);
    expect(r.ok).toBe(true);
  });

  it("fails with a reason when schema mismatch", () => {
    const r = validateAgainstSchema('{"question":"q","answer":"not-a-number"}', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/answer/);
  });

  it("fails when JSON is unparseable and unrepairable", () => {
    const r = validateAgainstSchema("just plain text with no json", schema);
    expect(r.ok).toBe(false);
  });

  it("accepts already-parsed objects", () => {
    const r = validateAgainstSchema({ question: "q", answer: 1 }, schema);
    expect(r.ok).toBe(true);
  });
});
