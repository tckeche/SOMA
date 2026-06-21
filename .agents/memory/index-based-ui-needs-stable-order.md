---
name: Index-based UI requires stable DB ordering
description: Why list-fetch queries feeding an index-positioned UI must always ORDER BY a stable key
---

# Index-positioned UI requires a deterministic DB order

Any storage query whose result feeds a UI that positions by **array index**
(e.g. `items[currentIndex]`) MUST include an explicit `ORDER BY` on a stable
column. Postgres does not guarantee row order without `ORDER BY`, so the order
can differ between two otherwise-identical `SELECT`s.

**Concrete incident (SOMA student quiz):** the soma quiz engine renders
`currentQuestion = questions[currentIndex]` while answers are keyed by
`questionId`. `getSomaQuestionsByQuizId` selected with no `ORDER BY`. On a
react-query refetch (default `refetchOnReconnect` on mobile, or `refetchOnMount`
after `staleTime`) or an autosave resume, the rows came back reordered, so the
same `currentIndex` pointed at a *different* question — the selected answer
appeared blank and a different MCQ/answer showed. Fix: `ORDER BY id ASC`
(serial id = generation/insertion order, the natural display order).

**Why:** id-keyed scoring/review were unaffected (order-independent); only the
index-based live engine broke, which made it look like a client state bug when
the root cause was a non-deterministic SQL read.

**How to apply:** when you see `arr[index]` driving navigation/selection, trace
back to the fetch and confirm it has a stable `ORDER BY`. A more robust (future)
hardening is to persist the *id* (not the index) in autosave and look the item
up by id.

# Grading vs. review comparison must use the same equality semantics

Server scoring uses `answersMatch` (mathValidator.ts) which **trims both sides**;
the review screen (`SomaQuizReview.tsx`) originally compared with raw `===`. A
stored answer differing only by whitespace would then be scored correct but show
"Incorrect"/highlight no correct option in review. Keep display equality aligned
with grading equality (a local `answersEqual` mirrors `answersMatch`).
