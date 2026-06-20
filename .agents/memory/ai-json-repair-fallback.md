---
name: AI structured-output policy (copilot/maker/verifier JSON)
description: Why LLM JSON parsing fails under provider fallback, and the policy — prefer provider-native structured outputs at the source; the repair ladder is fallback only.
---

# AI structured-output policy

**Rule:** every LLM call that must return JSON should pass an `expectedSchema` to
`generateWithFallback`. The orchestrator turns a schema into provider-native
structured output — Anthropic tool-use (returns `toolBlock.input`, guaranteed
syntactic JSON), OpenAI/DeepSeek/gpt-4o `response_format: json_object`, Gemini
`responseSchema`. Passing `undefined` lets every provider emit free-text JSON,
which is the original sin behind "generation produced no valid draft".

**Why this matters more than any repair code:** the primary model (e.g. GPT-5)
can time out or rate-limit and silently fall back to Claude/Gemini. Those
fallbacks routinely emit JSON that `JSON.parse` rejects. The two recurring fault
classes are (a) invalid backslash escapes from un-escaped LaTeX (`\alpha` → `\a`),
and (b) **unescaped inner double-quotes** plus literal control chars inside string
values — classic with IGCSE CS pseudocode like `OUTPUT "x"`. Case (b) is
**genuinely ambiguous**: neither the hand-rolled repair ladder nor the `jsonrepair`
library can reliably fix it (verified against adversarial payloads). The only
robust fix is to never produce broken JSON — i.e. structured output at the source.

**How to apply:**
- New JSON-returning LLM call → define a JSON Schema and pass it as the 3rd arg of
  `generateWithFallback`. Do NOT rely on post-hoc repair to bail you out.
- Gemini's schema converter rejects an OBJECT with empty `properties`. Any array
  of objects in the schema must list its common item fields explicitly. Leave
  `additionalProperties` permissive (default) so extra per-question fields (e.g.
  `graph_spec`) still flow through tool-use / json-mode.
- A schema with `required: [...]` is safe even for call sites that read only one
  key (e.g. graph-retry reads only `.questions`) — extra required keys are
  harmless when present.

**Repair ladder = defense-in-depth only.** The escalating repair helpers in
`aiContracts` still run, but only *after* a strict parse fails, so valid JSON is
never mutated. They are a last resort for any legacy call that lacks a schema, not
the primary contract. Keep new work on the structured-output path.

**Independent concern (not solved by this):** primary-model timeout/latency is a
separate SLO issue — structured output fixes parse resilience, not the GPT-5
timeout that forces the fallback in the first place.
