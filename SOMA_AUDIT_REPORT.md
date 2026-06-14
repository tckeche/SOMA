# SOMA — Focused Priority Audit Report

**Date:** June 14, 2026
**Scope:** (1) answer-validation false negatives **[priority]**, (2) review/navigation links, (3) core student journeys.
**Method:** static code audit of the grading + dashboard paths, Playwright end-to-end runs of the student journey, and targeted unit/integration tests. Only **safe, deterministic** fixes were applied, each with a proving test.

---

## Executive summary

Two real defects were found and fixed, both with regression tests:

1. **SOMA-001 (High) — answer-grading false negatives.** Student answers are trimmed on intake, but the *correct* value used for comparison was **not** trimmed. A correct selection whose stored option carried stray leading/trailing whitespace was silently marked **wrong**, costing the student marks. The same untrimmed comparison existed in **seven** grading/analytics sites (live scoring, regrade, mastery rollup, command-word coach, AI-feedback breakdown, performance analytics, and exclude-impact counting). All now use a shared whitespace-tolerant `answersMatch`.

2. **SOMA-002 (High) — dead links to archived/unpublished quizzes.** The student dashboard surfaced *pending/overdue* assignments whose quiz was archived or unpublished. Those quizzes 404 on the quiz/questions endpoints, so the assignment link hung forever on **"Loading assessment…"**. The dashboard composer now drops such pending assignments while preserving completed history (still reviewable via report id).

Both fixes were verified end-to-end: the student journey now completes cleanly (dashboard → completed history → review at `/soma/review/453`) with correctness markers rendering, LaTeX intact, **no false-negative observed**, and no `401/403/404/500` in browser or server logs.

The previously-observed `auth.token_invalid` 401 retry pattern on `/api/student/dashboard` is **no longer present** after the earlier `queryClient` bearer-token hardening.

---

## Environment

- **App:** React/Vite + Express, served on port 5000, `wouter` routing.
- **Auth:** Supabase email/password; `/api/*` requests carry a Supabase bearer token.
- **DB:** PostgreSQL (Supabase) via Drizzle. (Note: the Replit-managed SQL console hits a *different* database than the app's Supabase instance — relevant when spot-checking row state.)
- **Tests:** Vitest (`tests/vitest.config.ts`, node env). Playwright via the testing subagent.

---

## Auto-fixed (safe, deterministic, each with a proving test)

| ID | Severity | Area | Fix | Proving test |
|----|----------|------|-----|--------------|
| SOMA-001 | High | Answer grading | Added `answersMatch(student, correct)` (trims both sides, empty side never matches). Applied to all 7 student-vs-correct comparisons in `server/routes.ts` + `server/services/regrade.ts`. | `tests/answersMatchGrading.test.ts` (8 cases) |
| SOMA-002 | High | Dashboard links | Added `isPlayableQuiz(quiz)`; `buildStudentDashboard` now hides pending assignments to archived/unpublished quizzes, keeps completed history. | `tests/studentDashboardDeadLink.test.ts` (6 cases) |

Full suite for the touched surface stays green: `answersMatchGrading`, `regrade`, `mathValidator`, `answerKeyGuards`, `answerDiagnosis`, `studentDashboardDeadLink` — 66 tests passing. `tsc --noEmit` clean.

### SOMA-001 detail
- **Severity:** High (directly mis-scores students).
- **Repro:** a quiz whose stored correct option / answer string has stray whitespace (e.g. `"Paris "`); student selects the clean value `"Paris"`.
- **Observed vs expected:** scored **0** for a correct selection; expected the mark.
- **Root cause:** `sanitizeSubmittedAnswers` trims the student answer, but `effectiveCorrectAnswer(...)` returns a verbatim option / stored answer (untrimmed). The raw `studentAnswer === correctAnswer` comparison then mismatches on whitespace.
- **Fix:** whitespace-tolerant `answersMatch` (trim both sides; empty/undefined never matches, so unanswered questions still score 0). Applied consistently so submit-time scoring and regrade can never diverge.
- **Risk:** minimal. The only way trimming could create a *false positive* is two distinct options identical except for whitespace — a malformed question that is already broken; normal questions are unaffected.

### SOMA-002 detail
- **Severity:** High (core journey blocker — dead end).
- **Repro:** student has a pending/overdue assignment to a quiz that is archived or unpublished (observed live with quiz **428**).
- **Observed vs expected:** clicking the dashboard assignment navigated to `/soma/quiz/428`, which hung on "Loading assessment…" with repeated 404s on `/api/soma/quizzes/428` and `/api/soma/quizzes/428/questions`. Expected: the un-openable assignment should not be presented as actionable work.
- **Root cause:** `buildStudentDashboard` built rows from *all* assignments without the `!isArchived && status === "published"` gate that `/api/quizzes/available` already enforces. `AssignmentsList` then rendered a `/soma/quiz/:id` link the quiz endpoints reject.
- **Fix:** `isPlayableQuiz` gate; keep an assignment only if its quiz is playable **or** the assignment is completed (completed work stays reviewable via report id, preserving score history and stats).
- **Risk:** low. Only removes pending/overdue links to quizzes a student can never open (consistent with existing available-quiz semantics). Completed history and all graded stats are untouched.

---

## Open issues (flagged, NOT auto-fixed — out of "safe deterministic" scope)

- **SOMA-003 (Medium) — `effectiveCorrectAnswer` can change the marked option.** The deterministic math prover may override the stored correct answer with a different matched option. This is behaviour-altering (it can flip which option is "correct"), so it is outside the safe-fix boundary of this audit. Recommend a separate, evidence-backed review of prover overrides against a sample of live questions before touching it.
- **SOMA-004 (Low) — archived-mid-attempt edge.** If a quiz is archived while a student has an *incomplete* attempt (pending assignment + in-progress report), the SOMA-002 filter still hides it (kept only when `status === "completed"`). This is the correct safe default (an archived quiz can't be resumed), but if "resume in-progress attempts on archived quizzes" is a desired product behaviour it needs an explicit decision.
- **SOMA-005 (Low) — review correctness rendering is client-side.** `/api/soma/reports/:reportId` returns the (now consistent) correct answer, but the review page computes correct/incorrect in the client. Confirm the client comparison is also whitespace-tolerant so the *displayed* marker can never disagree with the *scored* result. (No mismatch was observed in testing.)

---

## Prioritised backlog

1. **SOMA-003** — audit deterministic prover overrides on real questions; decide keep/scope.
2. **SOMA-005** — align the client review comparison with `answersMatch` semantics (defensive; prevents display/score drift).
3. **SOMA-004** — product decision on in-progress attempts when a quiz is archived.
4. Consider a one-time data hygiene pass to trim stray whitespace in stored `correctAnswer` / option strings (root data cleanliness, complementary to the runtime tolerance now in place).

---

## Coverage gaps

- **Route-level integration tests** are thin; SOMA-002 was caught by Playwright, not a unit test (now covered at the composer level). A lightweight Express route harness would catch this class earlier.
- **Submit→score→review round-trip** is not exercised by an automated end-to-end test in CI; the audit covered it manually via Playwright. Worth adding.
- **Archived/unpublished quiz lifecycle** lacked any test; SOMA-002's test now pins the dashboard behaviour but not the quiz/questions 404 responses themselves.
