# Briefing for Codex — Examiner Loop is silently dead in production

## TL;DR

The Math-Quiz-Hub "Examiner Loop" — examiner reports → extract misconceptions → review queue → quiz Maker uses approved seeds for distractors → marker links wrong answers to misconceptions → student/cohort dashboards — has been **silently dead in production** for some time. Two bugs found and fixed on this branch (`claude/review-quiz-builder-oT0nw`); a third just spotted but not yet fixed; deployment of the fixes appears stuck.

User's complaint that triggered the investigation: *"people are not taking the dashboards seriously because the data there is not useful or necessary."* This is not a UX issue — it's that the FK column the dashboards depend on (`soma_questions.target_misconception_ids`) is NULL on every one of 2,998 production quiz questions.

The branch has 9 commits of forward progress. We need a second pair of eyes to verify the fixes are sound, identify whether any consumer is being missed, and help unblock the deployment so the fixes actually run.

---

## What the Examiner Loop is supposed to do

```
INPUT    examiner_misconceptions.status = 'approved'                       (3,791 rows)
   ↓
MAKER    soma_questions.target_misconception_ids                            (← bug 1 + bug 2)
   ↓
MARK     answer_diagnoses.misconception_id                                  (link wrong answers to known misconceptions)
   ↓
STUDENT  student_misconceptions                                             (per-student rollup)
   ↓
MASTERY  student_topic_mastery.{subtopic_id, learning_requirement_id}       (catalogue grain)
   ↓
DASH     student / tutor / super-admin dashboards
```

Every dashboard tile that says "you got this wrong because real Cambridge examiners flag this exact misconception" depends on FK column data that's been NULL the whole time.

---

## Diagnostic infrastructure on the branch

Three read-only diagnostic scripts — these are the source of truth, run them anytime:

| Script | What it does |
|---|---|
| `scripts/checkMisconceptionStatus.ts` | Counts approved/pending/rejected misconceptions and the catalogue-FK linkage breakdown. |
| `scripts/smokeTestExaminerLoop.ts` | Walks every link of the loop end-to-end and reports OK / WARN / FAIL per stage. |
| `scripts/diagnoseQuizSyllabusVsSeeds.ts` | For the most recent N quizzes, runs `listApprovedSeeds` against each quiz's parsed scope and reports how many seeds the production code path would return. Mirrors production logic exactly (imports the real function). |

Run all three to get the full picture in 30 seconds.

---

## Most recent smoke-test output (production database, 2026-05-01)

```
[ OK ]  INPUT — approved examiner_misconceptions
         3,791 approved (of 3,971 total)
         with subtopic_id (Maker uses):           2,005 (53% of approved)
         with learning_requirement_id (coaching): 1,242 (33% of approved)

[FAIL]  MAKER — distractor seeding (soma_questions.target_misconception_ids)
         0 of 2,998 questions carry seeds (0%)
         most recent seeded question:   none ever

[FAIL]  MARK — answer_diagnoses.misconception_id (per-answer attribution)
         0 of 8 wrong answers linked to a misconception (0%)
         total diagnoses written:     47
         last 7d activity: 48 new (0 with link)

[FAIL]  STUDENT — student_misconceptions (per-student rollup)
         0 (student × misconception) rows

[ OK ]  MASTERY — student_topic_mastery (catalogue grain)
         968 mastery rows (968 tested)
         with subtopic_id:           195 (20%)
         with learning_requirement_id: 0 (0%)
         last activity: 2026-05-01T14:39:23.050Z   ← live, deployment IS running
```

The MASTERY last-activity timestamp confirms the production app is alive and accepting writes. The 9 new questions inserted between consecutive smoke-test runs all had `target_misconception_ids = NULL`, which means the deployed bundle is still on pre-fix code.

---

## Bug 1 (FIXED, commit `be8ab36`): `DatabaseStorage.createSomaQuestions` silently dropped FK columns

**File:** `server/storage.ts:256` (`DatabaseStorage` class — production code path).

**The bug:** the `normalized` insert object listed legacy columns one-by-one and **silently omitted** every FK column added in subsequent migrations:

- `target_misconception_ids` (Phase 2 examiner-loop link — the column powering every dashboard tile that says "you got this wrong because of misconception X")
- `subtopic_id` (catalogue FK)
- `learning_requirement_id` (deeper coaching FK)
- `command_word` (cached column for command-word coaching)
- `assessment_objective` (cached AO rollup column)

Bug was effectively invisible: route handler passed all values correctly, TypeScript spread accepted the partial object, Drizzle accepted the partial insert, SQL INSERT silently wrote NULL for the omitted columns. The sibling `MemoryStorage` implementation at `storage.ts:1330` had the same fields correctly — the two implementations had simply drifted.

**The fix** (lines 273–277): added the five missing columns to the `normalized` map plus an inline comment block explaining why these lines must stay in lock-step with the schema.

**Test pinning the contract:** `tests/somaQuestionsPersistFkColumns.pg.test.ts` — 4 PGlite-backed cases covering round-trip persistence of `target_misconception_ids` (set + null), the other FK columns, and per-row arrays in a multi-row insert.

---

## Bug 2 (FIXED, commit `cd88ec7`): `listApprovedSeeds` returned empty due to board-label drift

**File:** `server/services/examinerDistractorSeeds.ts:55`.

**The bug:** when no specific subtopic IDs were supplied (the common case — most quizzes are scoped by syllabus, not by subtopic), the function applied **both** `eq(board, ?)` AND `eq(syllabus_code, ?)` strictly. But:

- Quizzes save `syllabus = "Cambridge Syllabus · 0580"`. The route's `parseBoardAndSyllabusCode` extracts `syllabusCode = "0580"` and leaves `board = "Cambridge Syllabus ·"` (with the middle-dot).
- Misconceptions are stored with `board = "Cambridge"` (clean, no suffix — that's how the extractor wrote them).
- Strict AND of `board="Cambridge Syllabus ·"` and `code="0580"` matched zero rows.

Effect: every recent quiz on Cambridge syllabi was seeded with an empty seed list, which compounded with bug 1 so even the eventual storage-fixed code would have nothing to persist.

**The fix:** when `syllabusCode` is present, drop the strict `board` filter. Cambridge syllabus codes (4 digits, e.g. 0580, 9709) are globally unique identifiers — not reused across boards. The `board` column is denormalized display text that drifts between writers ("Cambridge", "Cambridge IGCSE", "Cambridge Syllabus ·" all appear in the wild). The `syllabus_code` is the source of truth.

**Test pinning the contract:** `tests/examinerDistractorSeeds.pg.test.ts` — 7 PGlite-backed cases including the explicit format-drift case ("same code, three different stored board labels" all match).

---

## BUG 3 (NOT YET FIXED — please verify and decide)

**File:** `server/routes.ts:2905–2934` — the "AI Publish" path used by the per-student suggested-assessments flow (`/api/tutor/students/:studentId/ai/suggested-assessments` → publish).

**Smell:**

1. Lines 2905–2915 call `generateAuditedQuiz(...)` but the options object **does not include `examinerSeeds`**. Compare to:
   - `routes.ts:4732–4744` — the manual tutor-quiz route DOES call `listApprovedSeeds` and pass `examinerSeeds`.
   - `routes.ts:4831–4846` — the "/api/tutor/quizzes/generate" route DOES call `listApprovedSeeds` and pass `examinerSeeds`.

2. Lines 2930–2932 — when the questions are mapped into the `createSomaQuizBundle` call, the per-question payload **does not include `targetMisconceptionIds`**:

```ts
questions: generated.questions.map((q) => ({
  stem: q.stem, options: q.options, correctAnswer: q.correct_answer, explanation: q.explanation, marks: q.marks,
})),
```

So even if `examinerSeeds` were threaded through, the FK wouldn't be persisted on these questions because the call site never mentions it.

The two manual-tutor paths have:

```ts
questions: result.questions.map((q) => ({
  stem: q.stem, options: q.options, correctAnswer: q.correct_answer, explanation: q.explanation, marks: q.marks,
  targetMisconceptionIds,
})),
```

**This means**: every quiz that originates from the AI-suggested-assessments flow is unseeded by construction, regardless of bug 1 / bug 2.

**Question for Codex**: how heavily is this AI Publish path used in production vs the manual tutor-quiz paths? If most production quizzes come through this route, that explains why bug 1 and bug 2 alone wouldn't have populated the FK even if they'd been fixed earlier — there's a third gap.

The fix mirrors the manual paths: add a `listApprovedSeeds` call inside the per-item loop, thread `examinerSeeds` into `generateAuditedQuiz`, and add `targetMisconceptionIds` to the per-question map.

---

## Deployment situation

- Branch: `claude/review-quiz-builder-oT0nw` on `tckeche/Math-Quiz-Hub`.
- Recent commit graph (oldest at bottom):

```
8134da0  Make diagnoseQuizSyllabusVsSeeds call listApprovedSeeds directly
cd88ec7  Fix listApprovedSeeds — trust syllabusCode, ignore board label drift   ← BUG 2 fix
9488c85  Add diagnostic — does each recent quiz's syllabus match approved-seed scope?
2220ab6  Published your App                                                      ← LAST DEPLOY (pre-bug-2-fix)
be8ab36  Fix DrizzleStorage silently dropping target_misconception_ids + FK columns  ← BUG 1 fix
aeb5e97  Add Tier 1 end-to-end smoke test for the examiner loop
88c2e84  Add v2 best-fit prompt for learning_requirement judge retry pass
73b0f4c  LLM-judge fallback for learning_requirement_id backfill
6cd3a38  Backfill learning_requirement_id on examiner_misconceptions
56603c6  Show catalogue linkage breakdown in checkMisconceptionStatus
c16088d  Add read-only status diagnostic for examiner_misconceptions
b76730e  Add tiered automated triage for pending examiner misconceptions
```

The user's "Published your App" commit (`2220ab6`) was created BEFORE `cd88ec7`. So the deployed bundle includes the storage fix but NOT the seeds-filter fix. The user has run `git pull --rebase` multiple times and is asked to click Replit's Publish/Deploy button, but the smoke test continues to show new questions arriving without seeds — so either:

- The user hasn't actually clicked Publish (most likely).
- The user clicked Publish but it didn't rebuild (possible if Replit's cache is sticky).
- There are two deployment targets and we're publishing to the wrong one (possible — Replit has Workspace previews vs Reserved-VM/Autoscale Deployments which are separate).
- The deployed bundle picks up code from a specific git ref that isn't getting updated.

User's quote: *"i'm still getting the same shit"* — they've published but the smoke test still fails.

---

## Production database state

```
total examiner_misconceptions:    3,971
  approved:                        3,791
  pending:                           193
  rejected:                            7

approved & subtopic-linked:        2,005  (53% of approved — Maker can use these)
approved & learning-requirement-linked: 1,242  (33% of approved — coaching can use these)

approved across syllabi:
  Cambridge / 0580:  736  ← IGCSE Maths
  Cambridge / 0620:  443  ← IGCSE Chemistry
  Cambridge / 0610:  310
  Cambridge / 9701:  195
  Cambridge / 9709:  180
  Cambridge / 9618:    0  ← no approved seeds yet
  ...

soma_questions:                    2,998
  with target_misconception_ids:       0  (0% — should be populated for ~80% of recent rows)

answer_diagnoses:                     47
  with misconception_id link:          0  (0% — depends on quiz seeds existing first)

student_topic_mastery:               968  (live, last_activity within minutes)
  with subtopic_id:                  195  (20% — separate FK migration not finished)
  with learning_requirement_id:        0  (0% — never backfilled to mastery)
```

---

## Test status on this branch

```
$ npm test
Test Files  46 passed (46)
     Tests  644 passed | 30 skipped (674)
```

Six test files are PGlite-backed integration tests pinning the production code paths:

- `examinerInsightsReviewQueue.pg.test.ts`
- `examinerInsightsReviewMutations.pg.test.ts`
- `examinerInsightsReviewCounts.pg.test.ts`
- `triagePendingMisconceptions.pg.test.ts`
- `somaQuestionsPersistFkColumns.pg.test.ts`  (bug 1 regression)
- `examinerDistractorSeeds.pg.test.ts`        (bug 2 regression)

The PGlite harness lives at `tests/helpers/examinerInsightsReviewPgHarness.ts` and `tests/helpers/pglite.ts`.

---

## What would help most from Codex

In order of immediate value:

1. **Verify bug 3 is real** — read `server/routes.ts:2880–2940` and confirm the AI Publish path does not seed. If real, fix it the same way the manual paths are fixed.

2. **Find any other quiz-creation site that hits `createSomaQuestions` or `createSomaQuizBundle` without `targetMisconceptionIds`.** Other call sites we found:
   - `server/routes.ts:1116` — looks like a different post-marking/migration helper that already passes `targetMisconceptionIds`. Verify it's not broken.
   - `server/routes.ts:3206` — review the context around this `createSomaQuestions` call.
   - `server/seed.ts:7, 55` — seed scripts. Probably fine to leave unseeded but worth a glance.

3. **Add a `/api/health/version` endpoint** that returns the git commit hash of the deployed bundle. Easiest way: bake `process.env.GIT_COMMIT_SHA` at build time, fall back to reading it from `git rev-parse HEAD` in dev. This is the only durable way to confirm "is the deployed app actually on the commit we think it is" without console-logging from inside the route handler.

4. **Look for a Replit-specific deployment caveat** — is there a `.replit` config, a Reserved VM setting, or an Autoscale config that pins the deployment to a specific commit / build artifact / Nix store hash? The user's "Publish" may not actually rebuild from latest `HEAD`.

5. **Sanity-check the fixes** — read `server/storage.ts:256` and `server/services/examinerDistractorSeeds.ts:51` and confirm the changes are semantically correct. The PGlite tests pass, but four eyes are better than two.

---

## How to reproduce locally

```bash
# Clone and check out the branch
git clone <repo>
git checkout claude/review-quiz-builder-oT0nw

# Install + typecheck + test
npm install
npm run check    # tsc, must pass
npm test         # 644 passed

# Hit production database (needs DATABASE_URL / SUPABASE_DB_URL in .env)
npx tsx scripts/checkMisconceptionStatus.ts
npx tsx scripts/smokeTestExaminerLoop.ts
npx tsx scripts/diagnoseQuizSyllabusVsSeeds.ts

# All three are read-only — never write.
```

The user is reachable on this thread; replying with a verdict on bug 3 + a fix is the most useful next step.
