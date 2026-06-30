# Phase 6 Migration Map — Question Management Boundary

## CodeQL remediation confirmation

Before Phase 6 edits, the current branch already includes the CodeQL hardening commit:

- Supabase auth verification builds `/auth/v1/resend` and admin verification URLs from a trusted Supabase origin with `URL` and query parameters.
- Auth sync and auth-me logs use `emailHash` / `userIdHash` and no longer log raw emails, email domains, or raw user ids.
- File storage validates configured Supabase origins and validates/encodes storage object paths before upload, signed URL creation, deletion, and purge.
- PDF upload filenames are sanitized before persistence and before signed download filename hints.
- The router autoloader canonicalizes the module root, filters module directory names, realpaths `index.ts` / `index.js`, and refuses to import files outside the canonical module root.
- No CodeQL suppression comments were added.
- The previous hardening validation passed `npm run check`, `npm test`, and `npm run build`; Phase 6 will re-run the same commands after migration.

## Route shape discovered before editing

`POST /api/tutor/quizzes/:quizId/questions` is **manual insertion only**.

It does **not** call AI providers, `generateWithFallback`, `generateAuditedQuiz`, or prompt/model selection. It accepts a request body with `questions`, validates ownership and question shape, balances answer options, corrects MCQ answer keys through the existing deterministic validator, optionally repairs `graph_spec`, loads approved examiner misconception seeds for the quiz syllabus, maps each request question to `soma_questions` insert rows, calls `storage.createSomaQuestions`, and returns the saved rows.

The route is not an AI generation endpoint. It is a persistence boundary used after a client or another workflow already has question objects.

## Helpers used by the legacy route

- `newTraceId`, `traceLog`, and `countWithField` for trace logging.
- `MAX_QUESTIONS_PER_QUIZ` cap of 15.
- `parseBoardAndSyllabusCode` for examiner seed scope.
- `listApprovedSeeds` for fallback misconception attribution.
- `repairGraphSpec` for graph question repair/validation.
- `balanceAnswerOptions` and `validateAndCorrectMcqAnswers` for deterministic answer-option safety.
- `storage.getSomaQuiz`, `storage.getSomaQuestionsByQuizId`, and `storage.createSomaQuestions`.

## Extraction target

Create `server/modules/questionManagement` because this route is manual question insertion, not generation.

Planned files:

- `index.ts` — exports the domain module contract.
- `routes.ts` — mounts `POST /:quizId/questions` under `/api/tutor/quizzes` with `requireTutor`.
- `controller.ts` — parses params/body and translates domain errors to the existing JSON response shape.
- `service.ts` — owns ownership, cap, mapping, validation, trace logging, examiner seed fallback, and persistence workflow.
- `validators.ts` — owns `quizId` and request body parsing.
- `policies.ts` — owns tutor quiz ownership checks.
- `types.ts` — owns local question input and mapped row types.

## Behaviour to preserve

- Existing API path and successful response shape: array of saved question rows.
- Tutor ownership gate by quiz author id; request-provided author/tutor ids are ignored.
- Existing cap of 15 total questions per quiz.
- Existing MCQ/graph option count requirement.
- Existing deterministic answer balancing and answer correction.
- Existing graph spec validation/repair boundary.
- Existing trace logging events for add-question entry, seed load, before create, and after create.
- Existing fallback approved examiner seed attribution when a question does not provide explicit misconception ids.
- Student pre-submission routes must continue to omit answer keys.
- Tutor detail routes must continue exposing answer keys only for owned quizzes.

## Non-goals / Phase 6 boundaries

Leave these in `server/routes.ts` for later phases:

- AI copilot chat and draft mutation.
- AI quiz generation and tutor generate routes.
- Student quiz submission.
- Grading and structured marking.
- PDF AI marking.
- Examiner misconception extraction/linking beyond fallback seed lookup used by this manual route.
- AI report diagnosis.
- Mastery update side effects.
