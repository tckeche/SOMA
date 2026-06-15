---
name: SOMA end-to-end testing notes
description: How to provision test accounts and avoid false-positive failures when running Playwright/runTest suites against the single SOMA dev server.
---

## Run heavy browser suites sequentially, not many at once
The dev server is a single Express+Vite process. Running many concurrent
Playwright/`runTest` sessions that each also drive LLM calls (builder Co-Pilot,
grading) saturates it and produces transient **502s that look like app bugs but are
false positives**.
**Why:** in one session, "MCQ builder draft-sync failed", "adopt didn't persist", and
"/soma/chat broken" all turned out to be load artifacts — each PASSED when re-run in
isolation (draft-sync fine; adopt persisted a real `tutor_students` row; the chat
"failure" was correct empty-state gating, not a bug).
**How to apply:** before reporting a runTest failure, re-run that single suite in a
fresh isolated context. Treat 502/timeout clusters under parallel load as
infrastructure noise, not defects. `runTest` also caps at ~10 iterations per session —
budget runs and fall back to direct API checks for the grading lifecycle.

## Provisioning Supabase test accounts
- Use `VITE_SUPABASE_URL` (the https project URL) + `SUPABASE_SERVICE_ROLE_KEY` for
  the Admin API. `SUPABASE_URL` is a **Postgres connection string, not an https URL** —
  do not pass it to `createClient`.
- `super_admin` cannot be self-assigned: `determineRole` clamps signups to
  student/tutor. To get a super_admin, insert/seed the `soma_users` row directly with
  the role after creating the auth user.

## Grading lifecycle is verifiable without the browser
`POST /api/soma/quizzes/:id/submit` with `{ answers: { [questionId]: optionText }, startedAt }`
scores MCQ at submit time (`answersMatch`), returns the report `pending`, then
background grading flips it to `completed` within a few seconds. Poll
`GET /api/soma/reports/:reportId/review` to confirm. Good fallback when the browser
test budget is exhausted.
