---
name: Draft question normalisation must not silently drop
description: Why the copilot draft normaliser detects question type by shape and never discards questions silently
---

# Draft question normalisation must not silently drop questions

The tutor builder Co-Pilot normalises raw LLM question objects into draft
questions before persisting. Classifying a question by an exact `question_type`
token (or requiring a non-empty mark scheme) is fragile: when a generation falls
back to another provider (e.g. Gemini), that provider routinely mislabels the
type (synonyms like `short_answer`/`written`/`open` instead of `structured`) and
puts the mark scheme in an unexpected/empty field.

**Rule:** detect written-answer/structured by *shape* — no MCQ options, no graph
spec, has a stem — accepting both an explicit structured-token set and inference.
Never `return null` for a structured question just because the mark scheme is
empty; keep it (mark scheme may be "") so the publish gate surfaces the problem.
Always require `!hasMcqOptions && !hasGraphSpec` for structured classification so
a mislabeled real MCQ keeps its options instead of being coerced to structured.

**Why:** a normaliser that drops items silently turns a "15 questions generated"
success reply into "Replaced draft with 0 questions" with no trace. Whenever the
normaliser can drop an item, emit a per-`question_type` drop log so a zero-count
outcome is diagnosable instead of mysterious.

**How to apply:** any change to draft/question normalisation (copilot generate,
soma-generate, publish) must preserve shape-based detection + keep-don't-drop for
recoverable items, and keep the drop diagnostics in place.

**Two normalisers, keep in lockstep:** there is a server normaliser
(`server/routes.ts` `normaliseToDraftQuestion`) AND a client one
(`client/src/pages/builder.tsx` `rawToDraftQuestion`). The client one drives both
the live SSE preview and the final persistence path (`data.questions` →
`applyDraftAction` → `syncDraft`), so it is just as load-bearing as the server's.
A fix to one without the other causes preview-vs-persisted divergence. Match
field precedence, trimming, the structured-synonym set, and the
`!hasMcqOptions && !hasGraphSpec` shape guard on both.
