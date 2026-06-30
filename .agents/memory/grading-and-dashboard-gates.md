---
name: SOMA grading & dashboard playability gates
description: Two cross-cutting invariants for SOMA — answer comparisons must trim both sides, and assignment surfaces must reuse the quiz-playability gate.
---

## Answer comparisons must be whitespace-tolerant on BOTH sides
Student answers are trimmed on intake (`sanitizeSubmittedAnswers`), but the *correct*
value (`effectiveCorrectAnswer`, stored options) is returned verbatim. A raw
`studentAnswer === correctAnswer` therefore mis-scores a correct selection whose
stored option carries stray whitespace — a silent **false negative**.

**Rule:** never compare a student answer to a correct answer with `===`. Use
`answersMatch(student, correct)` from `server/services/mathValidator.ts` (trims both
sides; an empty/undefined side never matches, so unanswered stays 0).
**Why:** intake trimming and comparison drifted apart across ~7 grading/analytics
sites (live scoring, regrade, mastery rollup, command-word coach, AI feedback,
analytics, exclude-impact). Centralizing the comparison keeps submit-time and
regrade scoring from diverging.
**How to apply:** any new place that grades or counts correct vs incorrect must call
`answersMatch`, not `===`.

## Assignment surfaces must reuse the quiz-playability gate
The quiz and questions endpoints 404 any quiz that is archived or unpublished
(`isArchived || status !== "published"`). Any UI that links to `/soma/quiz/:id`
must apply the **same** gate, or it produces a dead link that hangs on
"Loading assessment…".

**Rule:** a quiz is playable iff `!isArchived && status === "published"`
(`isPlayableQuiz` in `server/services/studentDashboard.ts`). `/api/quizzes/available`
already enforces this; the dashboard composer now does too — it keeps an assignment
only if `isPlayableQuiz(quiz) || status === "completed"` (completed work stays
reviewable via `reportId`, preserving history/stats).
**Why:** the dashboard built rows from all assignments without the gate, surfacing
archived-quiz pending links that 404.
**How to apply:** do NOT broaden the keep-rule to "has a completed report" — in the
data-drift case (assignment still `pending` but report `completed` on an archived
quiz) the row renders as a *pending* link and 404s again. Fix status drift at the
source instead.

## The student "Pending assessments" tab must show ALL pending work (due date or not)
`AssignmentsList` (client) must keep every `status === "overdue"` or `status === "pending"`
row regardless of `dueDate`. It previously kept only `pending && !!dueDate`, so a pending
assignment with a null due date was returned by the API and shown on the dashboard hero
(`NextActions`) yet rendered the "Nothing pending right now" empty state on the dedicated
Assignments tab — a contradictory, broken experience for students.
**Why:** the tab header literally says "Pending assessments", so it must list all pending
work; "no due date" is NOT "not pending". The rendering already supports null due dates
("No due date" label; `Infinity` sort pushes undated rows last). Completed items stay excluded.
**How to apply:** keep the filter as `overdue || pending`. If a tutor reports "I assigned a
quiz but the student can't see it" and the API includes it in `data.assignments`, the bug is
a client-side filter, not the data — do not blame a missing `due_date`.
