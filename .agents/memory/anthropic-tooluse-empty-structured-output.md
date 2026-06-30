---
name: Anthropic tool-use returns valid-but-empty structured output
description: Claude (Opus 4.8) under tool-use can emit cleanly-parsing JSON whose array fields are empty while prose claims the work was done — a semantic failure no parser/repair ladder can catch.
---

# Anthropic tool-use: valid JSON, empty payload

Under Anthropic tool-use structured output, Claude Opus 4.8 intermittently
returns a **structurally valid, cleanly-parsed** JSON object whose data array is
**empty** (e.g. copilot `action=REPLACE_ALL/ADD` with `questions: []`) while the
free-text `reply`/summary field narrates that the work was completed ("I built
your 12-question quiz"). Output is tiny (~150 tokens) — it's not truncation and
not a parse failure.

**Why this matters:** the entire JSON-repair / contract ladder (`aiContracts`,
`extractStructuredCopilotResponse`) only defends against *malformed* JSON. It is
useless here because the JSON is valid — the model simply omitted the payload.
You must add a **semantic** check (array non-empty for a generating action) on
top of the structural parse, not rely on the parser.

**How to apply:**
- After parsing any structured LLM result whose value is the array (not the
  prose), assert the array is non-empty when the action implies it should be.
- On failure, retry once with a forceful corrective prompt and a generation-
  sized token budget (route-tagged separately, e.g. `*.chat_retry`).
- If still empty, NEVER reuse the model's success narrative — overwrite the
  reply with an honest failure message so the user isn't told it worked.
- Add a system-prompt rule: "never claim creation in `reply` unless the objects
  are present in the array" — helps but is insufficient alone; keep the
  server-side net.
- Separately: route copilot/authoring calls through the *generation* token
  budget, not "chat" (the 4096 chat cap truncates large drafts into invalid
  JSON — a distinct failure from the empty-array one above).
