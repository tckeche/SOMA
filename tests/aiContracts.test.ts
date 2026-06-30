/**
 * Tests for the JSON contract validation gate.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  validateAgainstSchema,
  repairJsonString,
  tryParseJson,
  escapeControlCharsInStrings,
  repairUnescapedInnerQuotes,
} from "../server/services/aiContracts";

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

  it("recovers JSON with unescaped inner quotes in a string value", () => {
    // Mirrors the production Gemini-verifier failure:
    // "Expected ',' or '}' after property value".
    const broken = '{"question":"He said "yes" to all of it","answer":3}';
    const r = validateAgainstSchema(broken, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.answer).toBe(3);
      expect(r.value.question).toContain("yes");
    }
  });

  it("recovers JSON with a literal newline inside a string value", () => {
    const broken = '{"question":"line one\nline two","answer":1}';
    const r = validateAgainstSchema(broken, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.question).toContain("line two");
  });
});

describe("aiContracts: escapeControlCharsInStrings", () => {
  it("escapes control chars inside strings but leaves structural whitespace", () => {
    const out = escapeControlCharsInStrings('{\n  "a": "x\ty"\n}');
    expect(JSON.parse(out)).toEqual({ a: "x\ty" });
  });

  it("is a no-op for already-valid JSON", () => {
    const valid = '{"a":"b","c":1}';
    expect(escapeControlCharsInStrings(valid)).toBe(valid);
  });
});

describe("aiContracts: repairUnescapedInnerQuotes", () => {
  it("escapes a quote in the middle of a value", () => {
    const out = repairUnescapedInnerQuotes('{"a":"say "hi" now"}');
    expect(JSON.parse(out)).toEqual({ a: 'say "hi" now' });
  });

  it("does not corrupt valid JSON with empty strings and structural quotes", () => {
    const valid = '{"a":"","b":"v","c":["x","y"]}';
    expect(JSON.parse(repairUnescapedInnerQuotes(valid))).toEqual({ a: "", b: "v", c: ["x", "y"] });
  });

  it("recovers a combined-fault payload: invalid LaTeX escapes AND inner quotes", () => {
    // The realistic Claude-fallback copilot payload: under-escaped `\alpha`
    // (invalid JSON escape) plus an unescaped inner quote. The extractor
    // composes sanitizeLatexBackslashes then repairUnescapedInnerQuotes, so
    // verify that composition recovers it.
    const broken = '{"reply":"use \\alpha here and say "hi"","answer":1}';
    const recovered = repairUnescapedInnerQuotes(sanitizeLatexBackslashes(broken));
    const parsed = JSON.parse(recovered);
    expect(parsed.answer).toBe(1);
    expect(parsed.reply).toContain("alpha");
    expect(parsed.reply).toContain("hi");
  });
});

import { sanitizeLatexBackslashes, repairControlCharCorruption, hasControlCharCorruption } from "../server/services/aiContracts";

describe("aiContracts: sanitizeLatexBackslashes", () => {
  it("doubles a single under-escaped backslash so JSON.parse keeps the LaTeX command intact", () => {
    // LLM emitted: {"opt":"$x = \frac{1}{2}$"}
    // Without sanitisation, JSON.parse converts \f → form-feed (0x0C):
    const raw = '{"opt":"$x = \\frac{1}{2}$"}';
    // Note: in JS source, \\ → one backslash on the wire, so `raw` represents
    // `{"opt":"$x = \frac{1}{2}$"}` exactly as the LLM would emit it.
    const broken = JSON.parse(raw);
    expect(broken.opt.includes("\u000Crac")).toBe(true);

    const fixed = JSON.parse(sanitizeLatexBackslashes(raw));
    expect(fixed.opt).toBe("$x = \\frac{1}{2}$");
    expect(fixed.opt.includes("\u000C")).toBe(false);
  });

  it("is a no-op when backslashes are already properly escaped", () => {
    const raw = '{"opt":"$x = \\\\frac{1}{2}$"}';
    expect(sanitizeLatexBackslashes(raw)).toBe(raw);
    expect(JSON.parse(sanitizeLatexBackslashes(raw)).opt).toBe("$x = \\frac{1}{2}$");
  });

  it("handles all the dangerous JSON escape collisions: \\b, \\t, \\v, \\f", () => {
    const raw = '{"a":"\\beta","b":"\\theta","c":"\\vec","d":"\\frac"}';
    const fixed = JSON.parse(sanitizeLatexBackslashes(raw));
    expect(fixed).toEqual({ a: "\\beta", b: "\\theta", c: "\\vec", d: "\\frac" });
  });
});

describe("aiContracts: repairControlCharCorruption", () => {
  it("reverses form-feed + letter back into a backslash + letter", () => {
    const corrupted = "$x = \u000Crac{5}{2}$";
    expect(repairControlCharCorruption(corrupted)).toBe("$x = \\frac{5}{2}$");
  });

  it("reverses tab/v-tab/backspace/bell + letter", () => {
    expect(repairControlCharCorruption("\u0009heta")).toBe("\\theta");
    expect(repairControlCharCorruption("\u0008eta")).toBe("\\beta");
    expect(repairControlCharCorruption("\u000Bec")).toBe("\\vec");
    expect(repairControlCharCorruption("\u0007lpha")).toBe("\\alpha");
  });

  it("does NOT touch newlines or carriage returns (they're often legitimate)", () => {
    const text = "Line one\nLine two\rEnd";
    expect(repairControlCharCorruption(text)).toBe(text);
  });

  it("recurses into arrays and objects", () => {
    const input = {
      stem: "$2x^2 - 3x - 5 = 0$",
      options: ["$x = \u000Crac{5}{2}$", "$x = 1$"],
      meta: { tag: "\u0009heta" },
    };
    expect(repairControlCharCorruption(input)).toEqual({
      stem: "$2x^2 - 3x - 5 = 0$",
      options: ["$x = \\frac{5}{2}$", "$x = 1$"],
      meta: { tag: "\\theta" },
    });
  });

  it("hasControlCharCorruption detects the buggy strings", () => {
    expect(hasControlCharCorruption("$x = \u000Crac{1}{2}$")).toBe(true);
    expect(hasControlCharCorruption("$x = \\frac{1}{2}$")).toBe(false);
    expect(hasControlCharCorruption("Plain text")).toBe(false);
  });

  it("returns non-plain objects (Date/Map/Set/Buffer) untouched instead of clobbering them with {}", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(repairControlCharCorruption(date)).toBe(date);

    const map = new Map([["k", "v"]]);
    expect(repairControlCharCorruption(map)).toBe(map);

    const set = new Set([1, 2, 3]);
    expect(repairControlCharCorruption(set)).toBe(set);

    class Custom { value = "$x = \u000Crac{1}{2}$"; }
    const inst = new Custom();
    // class instance is preserved as-is; we deliberately do NOT recurse into
    // class internals because we can't safely reconstruct an instance.
    expect(repairControlCharCorruption(inst)).toBe(inst);
  });
});

describe("aiContracts: validateAgainstSchema (LaTeX corruption end-to-end)", () => {
  const quizSchema = z.object({
    options: z.array(z.string()).length(4),
  });

  it("repairs unescaped \\frac via pre-parse sanitisation", () => {
    const llmEmitted = '{"options":["$x = \\frac{5}{2}$","$x = 1$","$x = 2$","$x = -1$"]}';
    const r = validateAgainstSchema(llmEmitted, quizSchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.options[0]).toBe("$x = \\frac{5}{2}$");
      expect(r.value.options[0].includes("\u000C")).toBe(false);
    }
  });

  it("repairs an already-parsed object that has form-feed corruption (Anthropic SDK path)", () => {
    // Anthropic SDK pre-parses the tool_use input; corruption may already
    // be baked in by the time we receive it.
    const alreadyParsed = {
      options: ["$x = \u000Crac{5}{2}$", "$x = 1$", "$x = 2$", "$x = -1$"],
    };
    const r = validateAgainstSchema(alreadyParsed, quizSchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.options[0]).toBe("$x = \\frac{5}{2}$");
    }
  });
});
