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
 * Validate a raw AI response (string OR already-parsed object) against a Zod
 * schema. Tries a single repair pass on parse failure.
 */
export function validateAgainstSchema<T>(raw: string | unknown, schema: z.ZodSchema<T>, opts?: { repair?: boolean }): ValidationOutcome<T> {
  const repair = opts?.repair ?? true;

  let parsed: unknown;
  let parseStatus: "success" | "failure" = "success";

  if (typeof raw === "string") {
    const first = tryParseJson(raw);
    if (first.ok) {
      parsed = first.value;
    } else if (repair) {
      const second = tryParseJson(repairJsonString(raw));
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
