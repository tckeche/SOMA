/**
 * Centralised JSON contract validation gate for AI responses.
 *
 * Every AI call that expects structured output should pass its raw response
 * through `validateAgainstSchema` BEFORE downstream consumers see it. If the
 * response fails parse OR schema, the gate can attempt a single deterministic
 * repair (strip code fences, extract first JSON object, lightweight cleanup)
 * before declaring the response invalid.
 *
 * If the raw response still cannot be reconciled with the schema, the caller
 * is expected to fall back to the next provider — no partially-validated
 * AI output should ever be passed downstream.
 */
import type { z } from "zod";

export interface ValidationOk<T> {
  ok: true;
  value: T;
  repaired: boolean;
  parseStatus: "success";
  validationStatus: "pass";
}

export interface ValidationErr {
  ok: false;
  reason: string;
  parseStatus: "success" | "failure";
  validationStatus: "fail";
}

export type ValidationOutcome<T> = ValidationOk<T> | ValidationErr;

/**
 * Best-effort cleanup of common LLM JSON-output mistakes:
 *  - markdown code fences ```json ... ```
 *  - leading/trailing prose around the JSON object
 *  - trailing commas before } or ]
 */
export function repairJsonString(raw: string): string {
  let s = raw.trim();

  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) s = fenceMatch[1].trim();

  const firstBrace = s.search(/[{[]/);
  if (firstBrace > 0) s = s.slice(firstBrace);

  // Match the outermost JSON object/array by tracking braces.
  if (s.startsWith("{") || s.startsWith("[")) {
    const open = s[0];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > 0) s = s.slice(0, end + 1);
  }

  // Remove trailing commas before closing brackets — a common LLM tic.
  s = s.replace(/,(\s*[}\]])/g, "$1");

  return s;
}

export function tryParseJson(raw: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e: any) {
    return { ok: false, error: e?.message || "JSON parse failure" };
  }
}

/**
 * LLMs writing LaTeX inside JSON strings frequently forget to escape the
 * backslash — they emit `"\frac{1}{2}"` when they should have emitted
 * `"\\frac{1}{2}"`. When that gets through JSON.parse, the parser silently
 * converts `\f` to U+000C (form-feed), `\b` to backspace, `\t` to tab,
 * `\v` to vertical tab — corrupting the LaTeX command into a control
 * character followed by `rac{1}{2}` etc.
 *
 * This helper doubles every odd-length backslash run BEFORE parse, so the
 * unescaped LaTeX command survives. Even-length runs are already properly
 * escaped and left untouched.
 *
 * Trade-off: an intended JSON `\n` (newline) inside a string becomes a
 * literal `\n` (two chars). For our use-case (math/quiz LLM output) this is
 * the right call — `\nu` (Greek nu) is far more likely than an intentional
 * embedded newline.
 */
export function sanitizeLatexBackslashes(raw: string): string {
  return raw.replace(/\\+/g, (run) => (run.length % 2 === 0 ? run : run + "\\"));
}

// Already-parsed strings sometimes still contain corrupted control chars —
// e.g. when parsing happened upstream (Anthropic SDK turns tool_use input
// into a JS object before it reaches us, OR JSON.parse silently ate `\f`).
// Map each control char back to the original two-char escape it stood in
// for. Newline (\n) and carriage-return (\r) are deliberately NOT repaired
// because they appear in legitimate text.
const CONTROL_TO_ESCAPE: Record<string, string> = {
  "\u0007": "\\a", // bell  → \a (e.g. \alpha, \angle)
  "\u0008": "\\b", // bs    → \b (e.g. \beta, \binom)
  "\u0009": "\\t", // tab   → \t (e.g. \theta, \tan, \times, \text)
  "\u000B": "\\v", // vtab  → \v (e.g. \vec, \varphi)
  "\u000C": "\\f", // ff    → \f (e.g. \frac)
};
const CONTROL_REPAIR_RE = /[\u0007\u0008\u0009\u000B\u000C](?=[A-Za-z])/g;
const CONTROL_REPAIR_DETECT_RE = /[\u0007\u0008\u0009\u000B\u000C][A-Za-z]/;

export function hasControlCharCorruption(value: string): boolean {
  return CONTROL_REPAIR_DETECT_RE.test(value);
}

/**
 * Walk an already-parsed JSON value and undo control-char corruption that
 * snuck through JSON.parse (form-feed + "rac" → `\frac`, etc.). Recurses
 * into arrays and objects; non-strings are returned as-is.
 */
export function repairControlCharCorruption<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(CONTROL_REPAIR_RE, (m) => CONTROL_TO_ESCAPE[m] ?? m) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(repairControlCharCorruption) as unknown as T;
  }
  // Only recurse into PLAIN objects — `Date`, `Map`, `Set`, `Buffer`, class
  // instances etc. expose no enumerable own keys via Object.entries, so the
  // naive "for ... of Object.entries" loop would silently return `{}` and
  // wipe the original value. Anything that isn't a plain object is returned
  // untouched.
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = repairControlCharCorruption(v);
      }
      return out as unknown as T;
    }
  }
  return value;
}

/**
 * Validate a raw AI response (string OR already-parsed object) against a Zod
 * schema. Tries a single repair pass on parse failure.
 *
 * Two layers of LaTeX-corruption defense run unconditionally:
 *  1. **Pre-parse**: when `raw` is a string, double odd-length backslash
 *     runs so unescaped LaTeX commands (`\frac`) survive JSON.parse.
 *  2. **Post-parse**: walk the parsed value and reverse any control-char
 *     corruption that slipped through (catches the Anthropic tool_use path
 *     where the SDK already parsed the JSON before we saw it).
 */
export function validateAgainstSchema<T>(raw: string | unknown, schema: z.ZodSchema<T>, opts?: { repair?: boolean }): ValidationOutcome<T> {
  const repair = opts?.repair ?? true;

  let parsed: unknown;
  let parseStatus: "success" | "failure" = "success";

  if (typeof raw === "string") {
    // Pre-parse defense: double odd-length backslash runs so under-escaped
    // LaTeX commands survive. Safe no-op when the LLM already escaped
    // backslashes properly.
    const presanitized = sanitizeLatexBackslashes(raw);
    const first = tryParseJson(presanitized);
    if (first.ok) {
      parsed = first.value;
    } else if (repair) {
      const second = tryParseJson(repairJsonString(presanitized));
      if (!second.ok) {
        return { ok: false, reason: `JSON parse failed: ${second.error}`, parseStatus: "failure", validationStatus: "fail" };
      }
      parsed = second.value;
    } else {
      parseStatus = "failure";
      return { ok: false, reason: `JSON parse failed: ${first.error}`, parseStatus, validationStatus: "fail" };
    }
  } else {
    parsed = raw;
  }

  // Post-parse defense: any control-char corruption that slipped through
  // (e.g. Anthropic SDK already parsed the JSON before we got it) gets
  // reversed back into proper backslash escapes.
  parsed = repairControlCharCorruption(parsed);

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, value: result.data, repaired: typeof raw === "string" && raw.trim() !== JSON.stringify(parsed), parseStatus: "success", validationStatus: "pass" };
  }
  return {
    ok: false,
    reason: result.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; "),
    parseStatus: "success",
    validationStatus: "fail",
  };
}
