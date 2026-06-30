# SOMA Phase 5 Migration Map

## Scope

Phase 5 migrates only the manual quiz draft and quiz publish workflow out of `server/routes.ts`. AI copilot chat, AI quiz generation, generated assessments, add-question generation, grading, structured marking, PDF AI marking, examiner misconception extraction/linking, report diagnosis, and mastery side effects remain in legacy routes.

## Domains to extract

- `quizDrafts`: `GET` and `PUT` current quiz draft endpoints plus the server-side in-memory draft store keyed by quizId.
- `quizPublish`: manual publish endpoint that validates the current draft (or client fallback draft) and atomically replaces persisted `soma_questions`.
- `questionValidation`: shared publish-time helpers for draft caps, review summaries, graph repair, graph/MCQ/structured validation, quality gates, topic-scope gates, and persistence mapping.

## Routes to migrate

- `GET /api/tutor/quizzes/:quizId/draft`
- `PUT /api/tutor/quizzes/:quizId/draft`
- `POST /api/tutor/quizzes/:quizId/publish`

## Routes intentionally left in legacy

- `POST /api/tutor/quizzes/:quizId/questions` remains because it is add-question generation/manual insertion adjacent to generation and will be migrated with the broader question-management/AI batch.
- AI copilot chat, AI-generated assessments, SOMA/tutor quiz generation, grading, structured marking, PDF AI marking, examiner misconception workflows, AI report diagnosis, and mastery updates remain deferred.

## Preservation requirements

- Keep tutor ownership gates on draft save/fetch and publish.
- Keep draft store keyed by quizId and clear it only after successful publish.
- Keep client-sent question fallback when the server draft is empty.
- Keep PDF-format publish with zero questions.
- Keep non-PDF empty draft rejection and max question cap.
- Keep structured mark-scheme, four-option MCQ/graph, graph repair/validation, quality, topic-scope, and explanation/answer mismatch gates.
- Preserve target misconception IDs, option rationales, subtopic IDs, learning requirement IDs, command words, assessment objectives, generation metadata, question type, and review-status summary.
