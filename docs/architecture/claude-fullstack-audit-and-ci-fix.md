# Full-Stack Audit & CI Fix — Post-Codex Route Migration

**Author:** Claude (independent audit of the Codex 12-phase route migration)
**Branch:** `claude/soma-route-audit-e6xq26`
**Date:** 2026-06-30 → 2026-07-01

---

## TL;DR

The GitHub CI failure was **not** a runtime "missing rate limiter" — it was a
**TypeScript compile failure** (`npm run check` / `tsc`) caused by a botched,
incomplete route migration in `server/routes.ts`. Investigating it uncovered
**three** distinct migration regressions that, together, would have taken the
whole backend down in production:

1. **Compile break** — `server/routes.ts` referenced deleted symbols
   (`pdfFileUpload`, `uploadPdf`, `deleteObject`, `createSignedDownloadUrl`,
   `isStorageConfigured`, `FileStorageError`) and contained a corrupted
   handler fragment (the head of the "mark submission" route spliced onto the
   tail of an "assign quiz" handler → undefined `studentIds`, `newAssignments`,
   …). `tsc` reported 25 errors. **CI died here, before `build`/`test` ran.**
2. **Autoloaded modules were never mounted** — a merge reverted
   `server/routes/index.ts::registerDomainRoutes()` from *delegating to*
   `registerDomainModules()` back to a hand-maintained 10-domain list. Every
   router-based module (`authAccount`, `pdfAttachments`, `pdfSubmissions`,
   `studentQuizTaking`, `tutorQuizzes`, `quizAssignments`, …) was silently
   **not registered** → those routes 404. This is why 108 integration tests
   failed the moment the compile break was fixed.
3. **Two green-CI features lost in the merge** — the `determineRole` **role-gate
   security hardening** and the tutor **regrade route** (both shipped green in
   PR #137 / `5ca9274`) were dropped when the Codex branch, forked from older
   `main`, was merged.

All three are fixed. Locally: `npm ci`, `npm run check`, `npm run build`, and
`npm test` (**1033 passed / 0 failed**, was 108 failing) are green. A dedicated
rate-limit coverage test suite was added. The full frontend↔backend contract was
verified intact.

---

## Part 1 — GitHub CI failure inspected

| Item | Value |
| --- | --- |
| Open PR for this branch | none (branch pushed without a PR) |
| Branch inspected | `claude/soma-route-audit-e6xq26` (at `main` HEAD `b3ad9c1`) |
| Failing commit(s) | `b3ad9c1`, `9fe159f`, `936cfad`, `42cdd8f`, `64f468f` — every push since PR #139 |
| Last GREEN commit | `5ca9274` (PR #137), `a098a1d` (PR #138) |
| Failing workflow | `CI` (`.github/workflows/ci.yml`) |
| Failing job | `build-test` (ubuntu-latest, Node 20) |
| Failing step | `npm run check` (`tsc`) |
| Exact failing command | `tsc` |
| CodeQL / Semgrep alerts | none surfaced in the failing runs (only the `tsc` step failed) |
| Deployment/preview checks | none configured in the repo |
| Is the failure rate-limit related? | **No.** Root cause is a `tsc` compile break in `server/routes.ts`. The affected lines happen to be the upload/PDF/storage/assignment routes ("routes that require rate limiting"), which is why the failure was described that way. |
| Stale or attached to latest commit? | Attached to the latest commit (`b3ad9c1`) and every push back to #139. |
| Reproduces locally? | **Yes** — `npm run check` reproduced all 25 errors on the unmodified tree. |

### Exact failure output (from run `28478573852`, job `build-test`)

```
server/routes.ts(53,35): error TS2440: Import declaration conflicts with local declaration of 'publicSubmission'.
server/routes.ts(965,14): error TS2552: Cannot find name 'pdfFileUpload'. Did you mean 'pdfUpload'?
server/routes.ts(2272,20): error TS2304: Cannot find name 'studentIds'.
server/routes.ts(2273,19): error TS2304: Cannot find name 'newAssignments'.
… (2274 alreadyAssignedIds, 2275 notAdoptedIds, 2276 perStudent, 2277 newAssignments, 2278 perStudent)
server/routes.ts(2530,10): error TS2552: Cannot find name 'isStorageConfigured'.
server/routes.ts(2563,42): error TS2304: Cannot find name 'deleteObject'.
server/routes.ts(2594,15): error TS2304: Cannot find name 'uploadPdf'.
server/routes.ts(2606,28): error TS2304: Cannot find name 'FileStorageError'.
server/routes.ts(2712,27): error TS2304: Cannot find name 'createSignedDownloadUrl'.
… (25 errors total) Process completed with exit code 2.
```

### Root cause

`server/routes.ts` was left in a half-migrated, partially-corrupted state:

- The `fileStorage` helper imports (`uploadPdf`, `deleteObject`,
  `createSignedDownloadUrl`, `isStorageConfigured`, `FileStorageError`) were
  removed from the import list, but the inline PDF routes that used them were
  **not** removed — leaving dangling references.
- A new `import { … publicSubmission … } from "./modules/fileStorageAccess/service"`
  was added while the **local** `publicSubmission` definition was left in place →
  `TS2440` import/local conflict.
- A **corrupted handler fragment** was spliced in: the head of
  `POST /api/tutor/submission-uploads/:id/mark` glued onto the tail of the
  assign-quiz handler (`res.json({ requested: studentIds.length, … })`),
  referencing variables that don't exist in that scope.
- `pdfUploadField()` referenced `pdfFileUpload` (the multer instance name only
  used in the module), but the local multer instance is named `pdfUpload`.

### Fix strategy

1. Delete the duplicated/corrupted inline PDF code; the `pdfAttachments` /
   `pdfSubmissions` modules already own those routes.
2. Re-wire `registerDomainRoutes()` to delegate to `registerDomainModules()` so
   the autoloaded modules actually register.
3. Restore the lost `determineRole` hardening and the `regrade` route from the
   last green commit.
4. Remove every remaining migrated route that was still duplicated inline.
5. Add rate-limit coverage tests and this document.

---

## Part 2 — CI commands & local reproduction

`.github/workflows/ci.yml` runs exactly: `npm ci` → `npm run check` → `npm run
build` → `npm test`. All four were run locally (see Part 14). No extra CI
commands exist. `npm run check` = `tsc`; `npm run build` = `tsx script/build.ts`
(vite client + esbuild server bundle); `npm test` = `vitest run --config
tests/vitest.config.ts`.

---

## Part 3–4 — Rate-limit audit

### Limiter architecture (two layers)

**Layer 1 — global per-prefix limiters**, mounted with `app.use()` in
`registerRoutes()` *before* `registerDomainRoutes(app)`, so they also cover the
autoloaded module routes:

| Prefix | Limiter | Window / max |
| --- | --- | --- |
| `/api/admin` | `adminRateLimiter` | 15m / 100 |
| `/api/auth` | `authApiLimiter` | 15m / 60 (auth-aware 429 logging) |
| `/api/tutor` | `tutorApiLimiter` | 15m / 300 |
| `/api/super-admin` | `superAdminApiLimiter` | 15m / 180 |
| `/api/student` | `studentApiLimiter` | 15m / 240 |
| `/api/quizzes` | `studentApiLimiter` | 15m / 240 |
| `/api/soma` | `somaAiLimiter` | 1m / 10 (skips `/generate`, `/global-tutor`) |

**Layer 2 — dedicated per-route limiters** on the sensitive surface (auth, AI,
upload, grading). AI limiters are **keyed by server-resolved identity**
(`aiRateLimitKey` → `req.authUser`/`req.tutorId`, falling back to `ipKeyGenerator(req.ip)`)
— never client-supplied ids.

### Sensitive-route limiter coverage (verified)

| Route | Limiter(s) | Category |
| --- | --- | --- |
| `POST /api/admin/login` | `loginLimiter` (15m/5) + admin prefix | Required strict ✓ |
| `POST /api/auth/sync` | `authSyncLimiter` (15m/30) + auth prefix | Required strict ✓ |
| `GET  /api/auth/me` | auth prefix | OK (read) ✓ |
| `POST /api/auth/forgot-password` | `forgotPasswordLimiter` (15m/5) + auth prefix | Required strict ✓ |
| `POST /api/auth/send-verification-code` | `verificationCodeSendLimiter` (15m/5) | Required strict ✓ |
| `POST /api/auth/resend-verification` | `verificationResendLimiter` (15m/5) | Required strict ✓ |
| `POST /api/auth/verify-verification-code` | `verificationCodeVerifyLimiter` (15m/10) | Required strict ✓ |
| `POST /api/soma/generate` | `legacyAdminAiLimiter` (15m/200) | Required strict (AI) ✓ |
| `POST /api/tutor/quizzes/generate` | `tutorGenerationAiLimiter` (15m/300) | Required strict (AI) ✓ |
| `POST /api/tutor/copilot-chat` | `tutorCopilotAiLimiter` (15m/30) | Required strict (AI) ✓ |
| `POST /api/tutor/ai/intervention-insights` | `tutorAnalyticsAiLimiter` (15m/40) | Required strict (AI) ✓ |
| `POST /api/tutor/ai/student-summary` | `tutorAnalyticsAiLimiter` (15m/40) | Required strict (AI) ✓ |
| `POST /api/tutor/students/:id/ai/suggested-assessments` | `tutorAnalyticsAiLimiter` **(ADDED)** | Required strict (AI) ✓ |
| `POST /api/tutor/students/:id/ai/publish-suggested` | `tutorAnalyticsAiLimiter` **(ADDED)** | Required strict (AI) ✓ |
| `POST /api/soma/global-tutor` | `globalTutorAiLimiter` (role-scoped) | Required strict (AI) ✓ |
| `POST /api/soma/spellcheck` | `somaAiLimiter` (1m/10) | Required strict (AI) ✓ |
| `POST /api/analyze-class` | `analyzeClassLimiter` (15m/20) | Required strict (AI) ✓ |
| `POST /api/graph/render-svg` | `graphRenderLimiter` | Required strict (AI) ✓ |
| `POST /api/upload-image` | `uploadImageLimiter` (15m/30) | Required (upload) ✓ |
| `POST /api/tutor/quizzes/:id/attachments` | `tutorApiLimiter` (module) + prefix | Required (upload) ✓ |
| `POST /api/quizzes/:id/submission-upload` | `studentApiLimiter` (module) + prefix | Required (upload) ✓ |
| `POST /api/tutor/submission-uploads/:id/mark` | `tutorApiLimiter` + prefix | Required (grading) ✓ |
| `POST /api/soma/quizzes/:id/submit` | soma prefix (1m/10) | Required (mutation) ✓ |
| `POST /api/soma/reports/:id/request-review` | soma prefix | Required (mutation) ✓ |
| `POST /api/soma/reports/:id/retry` | soma prefix | Required (grading) ✓ |
| `PUT  /api/tutor/reports/:id/structured-marking` | tutor prefix (15m/300) | Required (grading) — prefix-covered ✓ |
| `POST /api/tutor/quizzes/:id/regrade` | tutor prefix (15m/300) | Required (grading) — prefix-covered ✓ |

### Routes with **no** limiter (reviewed & accepted)

Not under a global prefix and without a dedicated limiter:

- `GET /api/catalogue/{examining-bodies,levels,subjects,topics,topic-context}` — `requireTutor`, low-cost catalogue reads. **Category: no limiter needed.**
- `POST /api/diagnostics/client-error` — `requireSupabaseAuth` error-report sink; low cost. **Category: optional.**
- `GET /uploads/:filename` — static image serve; intentionally not aggressively limited per audit guidance.

No sensitive (auth/AI/upload/grading/mutation) route is unprotected.

---

## Part 5 — Rate-limit implementation notes

- **No new limiter families were created.** The two gaps
  (`ai/suggested-assessments`, `ai/publish-suggested`) were closed by reusing the
  existing `tutorAnalyticsAiLimiter`.
- Existing limits were **not weakened or removed**.
- AI keying uses **server-resolved identity only** (`getSafeRateLimitUser` reads
  `req.authUser`/`req.tutorId`, both set by verified-token middleware) — never
  `req.body`/`req.params` ids, roles, or emails.
- Limiter logs hash emails (`hashEmailForLog`) and never log signed URLs,
  prompts, answers, reports, or storage paths. (Pre-existing note: the AI-limit
  `console.warn` includes the resolved `userId`; this is pre-existing ops logging
  and was left unchanged — no new raw-id logging was introduced.)

---

## Part 6 — Codex migration correctness

| Check | Result |
| --- | --- |
| Every `staticManifest` module exists on disk | ✅ 29/29 |
| Every autoloaded module exports the `moduleDefinition` contract | ✅ (`routerLoader.validateModuleDefinition` + tests) |
| `routerLoader` discovers filesystem modules safely (realpath + root containment) | ✅ `assertPathInsideRoot`, `discoverModuleFiles` |
| `staticManifest` fallback works (bundled prod build) | ✅ `discoverDomainModules({useStaticFallback})` |
| No module registered twice | ✅ `validateNoDuplicates` (name + route signature) |
| **Modules actually mounted** | ❌→✅ **FIXED** — `registerDomainRoutes` now delegates to `registerDomainModules` |
| No migrated route remains inline | ❌→✅ **FIXED** — 12 duplicate inline routes removed (see Part 15) |
| Remaining inline routes documented | ✅ (Part 16) |

---

## Part 7 — Full-stack (frontend↔backend) contract

Cross-referenced **125 distinct frontend `/api/*` paths** against **163 backend
routes** (inline + router modules + register modules + catalogue routers).
**0 broken contracts.** The 11 apparent mismatches were all confirmed false
positives: catalogue routes served via a `register`-contract module
(`app.use("/api/catalogue", …)`), React-Query key prefixes
(`["/api/soma/reports", id, "review"]`), and the multi-line `/mark` route.
No public API path was changed.

---

## Part 8 — Security audit

| Invariant | Status |
| --- | --- |
| Student pre-submission responses hide `correctAnswer`/`correct_answer` | ✅ (phase3/5/6 tests assert `not.toContain`) |
| …hide `optionRationales`, `targetMisconceptionIds`, review metadata | ✅ (`sanitizeQuestionForPreSubmission`, phase tests) |
| Student cannot read another student's report | ✅ ownership checks in student report routes |
| Tutor answer keys only to owning tutor | ✅ `quiz.authorId === tutorId` gating |
| `storagePath` / `annotatedStoragePath` never in responses | ✅ `publicSubmission`/`publicAttachment` strip them |
| Signed URLs / raw emails / prompts / answers / reports not logged | ✅ (emails hashed via `hashEmailForLog`) |
| File storage paths validated | ✅ `isSafeStoragePath` in `fileStorageAccess` |
| Router-loader dynamic imports cannot escape module root | ✅ `assertPathInsideRoot` + realpath |
| Ownership never trusted from client-supplied id/role | ✅ gating uses `req.tutorId`/`req.authUser` |
| **`determineRole` privilege-escalation** | ❌→✅ **FIXED** (see below) |

### Security regression fixed: tutor role self-provisioning

`server/modules/authAccount/policies.ts` shipped with:

```ts
if (requestedRole === "tutor") return "tutor";   // anyone could self-provision tutor
```

Restored the PR-#137 hardening: a client `requested_role` grants `tutor` **only**
when the email is on `TUTOR_EMAIL_DOMAIN` or the server-side
`TUTOR_EMAIL_ALLOWLIST`; otherwise it defaults to `student`. `super_admin` is
never self-selectable. Pinned by `tests/tutorSignupRoleGate.test.ts` (now green).

---

## Part 9 — AI & examiner-loop audit

The AI quiz-generation / publish path (`POST /api/soma/generate`,
`POST /api/tutor/quizzes/generate`, `quizPublish`, `questionManagement` modules)
preserves the intelligence fields end-to-end — verified functionally by the
phase 5/6 tests, which assert the round-trip of `targetMisconceptionIds`,
`optionRationales`, `subtopicId`, `learningRequirementId`, `commandWord`,
`assessmentObjective`, `generationMeta`, `reviewStatus`, graph validation, and
the 15-question cap. Copilot / spellcheck / global-tutor / class-analysis /
intervention-insights / student-summary / suggested-assessments retain their
tutor-adopted-student and admin gates and are rate-limited (Part 4). See the
"soma-security-ai-verify" workflow findings appended below for the independent
adversarial confirmation.

---

## Part 14 — Duplicate-route audit

12 inline routes in `server/routes.ts` still duplicated a router module (module
handlers win because they register first, so the inline copies were dead code)
and were removed:

`POST /api/tutor/quizzes/:quizId/clone`, `DELETE …/unassign/:studentId`,
`GET …/details`, `GET …/review`, `PATCH …/questions/:questionId/review`,
`POST /api/tutor/quizzes`, `GET …/detail`, `GET …/draft`, `PUT …/draft`,
`POST …/publish`, `PUT /api/tutor/quizzes/:quizId`, `POST …/questions`
— plus the 9 already-corrupted inline PDF attachment/submission routes.

Guarded going forward by `tests/rateLimitCoverage.test.ts` ("does not re-declare
any migrated route inline") and `validateNoDuplicates` in the loader.

---

## Part 15 — `server/routes.ts` remaining-route audit

After cleanup, `routes.ts` legitimately still owns the not-yet-migrated surface:
student dashboard/reports/flags/notifications/insights, super-admin
users/quizzes/stats/tutors, admin login/session/logout, `/api/upload-image`,
`/api/analyze-class`, the SOMA AI routes (`generate`, `spellcheck`,
`global-tutor`, quiz `submit`, report `review`/`request-review`/`retry`),
tutor copilot + student-AI + analytics routes, tutor students/mastery/cohort/
performance, syllabus documents, structured-marking, `regrade`, the tutor
`submission-uploads/:id/mark` route, and `/uploads/:filename`. All are documented
inline as intentionally-inline.

---

## Files changed

| File | Change |
| --- | --- |
| `server/routes.ts` | Removed corrupted fragment + 12 duplicate inline routes + module-owned helpers (~1130 lines); restored `regrade` route; added `tutorAnalyticsAiLimiter` to 2 AI routes. |
| `server/routes/index.ts` | Restored `registerDomainRoutes` → `registerDomainModules` delegation (re-mounts all autoloaded modules). |
| `server/modules/authAccount/policies.ts` | Restored `determineRole` allowlist hardening (security). |
| `tests/rateLimitCoverage.test.ts` | **New** — proves limiter coverage, manifest completeness, and no inline re-declaration of migrated routes. |
| `docs/architecture/claude-fullstack-audit-and-ci-fix.md` | This report. |

## Tests added / updated

- `tests/rateLimitCoverage.test.ts` (7 tests): global-prefix mounts + ordering,
  AI-route limiters, auth/verification/login strict limiters, upload limiters,
  grading-mark limiter, `staticManifest` completeness, no inline re-declaration.
- No tests were removed or weakened. The previously-red suites
  (`tutorSignupRoleGate`, `regradeRoute`, `phase3/5/6Routes`, `pdfUploadRoutes`,
  `routes`, `tutorQuizOwnershipIdor`, `phase2Routes`) now pass because the
  underlying regressions are fixed.

---

## Commands run & results

| Command | Result |
| --- | --- |
| `npm ci` | ✅ 685 packages, exit 0 |
| `npm run check` (`tsc`) | ✅ clean (was **25 errors**) |
| `npm run build` | ✅ vite client + esbuild server bundle |
| `npm test` | ✅ **84 files, 1033 passed, 30 skipped, 0 failed** (was 108 failing) |
| focused phase tests (`phase2…12`, `routerLoader`, `fileStorage`, `pdfUploadRoutes`) | ✅ all green |
| `tests/rateLimitCoverage.test.ts` | ✅ 7/7 |

---

## Merge safety

- **Safe to merge.** All CI commands pass locally; the fix is the completion of
  the Codex migration, not new feature work.
- The failure was **internal/code** (compile break + un-mounted modules + lost
  merge commits), fully reproduced and fixed locally — not an external/flaky CI
  issue.
- **Post-migration feature work can safely continue**: the autoloaded module
  system is now actually wired, duplicates are gone, and the loader's
  `validateNoDuplicates` + the new coverage test guard against regressions.

---

## Appendix — Independent adversarial verification (5-agent workflow)

A `soma-security-ai-verify` workflow ran 5 parallel agents that read the actual
post-fix code and returned structured verdicts. **All five: HELD, zero gaps.**

| Dimension | Verdict | Key evidence |
| --- | --- | --- |
| Student pre-submission answer-key hiding | ✅ HELD | `studentQuizTaking/service.ts:8-18` `sanitizeQuestionForPreSubmission` returns a `Pick` of safe fields only; answer keys only post-submission via report review with ownership gate |
| Storage-key / sensitive-data exposure | ✅ HELD | `fileStorageAccess/service.ts:59-67` strips `storagePath`/`annotatedStoragePath`; `pdfAiMarking.ts` `stripStorage`; downloads return signed-URL only; no path/prompt/email logging |
| Ownership not from client | ✅ HELD | `auth.ts:244-253` id from JWT `sub`; `tutorQuizzes/service.ts:11-15` `assertOwnedQuiz`; `authAccount/policies.ts` allowlist gate; IDOR regression test present |
| AI quiz-gen field preservation | ✅ HELD | `targetMisconceptionIds`, `optionRationales`, `subtopicId`, `learningRequirementId`, `commandWord`, `assessmentObjective`, `generationMeta`, `reviewStatus` all persisted; examiner seeds, graph retry, 15-q cap, scope gates intact |
| AI copilot + diagnostics gating | ✅ HELD | All 8 routes auth-gated; tutor adopted-student 403 gates enforced; each has a dedicated or prefix AI limiter |

No regressions or security gaps were found by the independent pass.

---

## Follow-up (post-merge) — P1 production-startup fix

A Codex PR review on #142 flagged a **P1**: wiring `registerDomainModules()`
made `discoverDomainModules()` scan `process.cwd()/server/modules` at runtime.
In the bundled production build (`NODE_ENV=production node dist/index.cjs`) with
the repo source present (e.g. Replit copies the source tree alongside `dist`),
the loader found the TypeScript module indexes and tried to dynamically import
them — which plain Node cannot do — instead of the compiled-in `staticManifest`,
aborting route registration with `ERR_MODULE_NOT_FOUND` so the server never
listened. (CI never caught this: it runs `build` + `vitest`, never
`node dist/index.cjs`.)

**Reproduced** under plain Node against the esbuild-bundled loader:
`CRASH: ERR_MODULE_NOT_FOUND - Cannot find module '.../authAccount/routes'`.

**Fix** (`server/modules/routerLoader.ts`): when `NODE_ENV==="production"` and no
explicit `rootDir` is given, `discoverDomainModules()` uses the static manifest
and skips filesystem discovery entirely. Dev (tsx) and tests (vitest) still load
`.ts` via live discovery; the loader's own tests pass an explicit `rootDir` and
keep discovery. Post-fix, the bundled loader returns all 29 manifest modules
with no filesystem access. Pinned by `tests/routerLoaderProduction.test.ts`
(mocks `readdir` to throw → production must not touch the filesystem).

