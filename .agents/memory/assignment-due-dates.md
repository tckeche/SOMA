---
name: Assignment due-date defaults & datetime-local serialization
description: The default-due-date policy lives in one shared helper, and every assign UI must serialize datetime-local to ISO before POSTing.
---

## Default due date = createdAt + 5 days, floored to the hour
When a tutor assigns an assessment without picking a due date, it defaults to 5 days
after the quiz's `createdAt`, with minutes/seconds zeroed (created 15:23 -> due in 5
days at 15:00). Source of truth: `shared/dueDate.ts` (`computeDefaultDueDate`,
`defaultDueDateInputValue`). The server assign route applies it as a fallback; the
tutor UIs prefill the picker with it.
**Why:** a single shared helper keeps the server fallback and all client prefills in
lockstep. Before this, a null due date meant "no due date" — now assigns always carry
one unless the tutor clears/changes it.
**How to apply:** never re-implement the +5-day/floor math inline; import the helper.
The change-due-date (`PATCH .../due-date`) and extend flows are separate and do NOT
apply this default.

## Every assign UI must convert datetime-local -> ISO before POST
There are THREE tutor assign entry points (`TutorAssessments`, `TutorAssessmentDetails`,
`TutorDashboard` — the last has two modals), all hitting
`POST /api/tutor/quizzes/:quizId/assign`. The server parses `dueDate` with
`new Date(rawDueDate)`.
**Why:** `<input type="datetime-local">` yields a local-time string with no offset. If
sent raw, the server interprets it in server-local time (usually UTC), so the persisted
hour drifts for non-UTC tutors — and it diverged between UIs (one sent raw, two sent
ISO). Always do `new Date(value).toISOString()` client-side before POSTing.
**How to apply:** any new assign surface must serialize the picker value to ISO; keep
all entry points consistent or due dates differ for identical visible input.
