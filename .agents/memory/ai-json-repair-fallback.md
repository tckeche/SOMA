---
name: AI JSON repair fallback ladder
description: Why fallback LLMs (Claude/Gemini) silently yield zero questions when the primary (GPT-5) is rate-limited, and the repair invariants that keep recovery working.
---

# AI JSON repair fallback ladder

When the primary model (GPT-5) is rate-limited (429) the pipeline falls back to
Claude Opus (copilot/maker) and Gemini (verifier). Those fallbacks routinely emit
JSON that `JSON.parse` rejects, and a single repair attempt is not enough — so the
copilot extractor dropped to a NONE fallback and the verifier "returned unaudited
drafts", leaving tutors with ZERO attached questions even though the model
"succeeded".

**Two recurring fault classes** (often combined in one payload):
- Invalid backslash escapes from un-escaped LaTeX (`\alpha`, `\angle` → `\a` is not
  a valid JSON escape).
- Unescaped inner double-quotes and literal control chars inside string values.

**Invariants that must hold for any repair work here:**
- The escalating repair ladder runs **only after** a strict parse fails, so valid
  JSON is never mutated. Heuristic repairs (escape control chars, escape inner
  quotes) are last-resort steps, accepted as semantically lossy on already-broken
  input.
- A combined-fault payload needs the ladder run over **both** the raw base and the
  LaTeX-backslash-sanitized base — sanitizing backslashes alone, or fixing quotes
  alone, each misses payloads that have both faults.
- The inner-quote heuristic treats a `"` as a string terminator only when the next
  non-whitespace char is `,` `:` `}` `]` or EOF; otherwise it escapes it. This is
  what keeps empty strings and structural quotes intact.

**Why:** a provider outage must degrade to "questions still generated" not "zero
questions, no error surfaced". The shared repair helpers in aiContracts are the
single recovery path; keep the copilot extractor and every verifier routed through
the same ladder rather than re-inventing per-call repairs.
