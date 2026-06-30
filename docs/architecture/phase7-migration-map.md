# Phase 7 Migration Map — Question Deletion Boundary

## Phase 6 branch confirmation

The current branch includes Phase 6 question management extraction:

- `POST /api/tutor/quizzes/:quizId/questions` is manual insertion only and lives in `server/modules/questionManagement`.
- Phase 6 kept tutor ownership, validation, graph handling, the 15-question cap, attribution fields, answer-key safety, and CodeQL hardening intact.
- Phase 7 extends the same `questionManagement` domain instead of introducing a new module.

## Route shape discovered before editing

`DELETE /api/tutor/questions/:questionId`

Legacy implementation in `server/routes.ts`:

1. Requires `requireTutor`.
2. Reads authenticated tutor id from `req.tutorId`.
3. Parses `questionId` from `req.params.questionId` with `parseInt`.
4. Returns `400 { message: "Invalid question ID" }` for invalid ids, wrapped by the global error envelope.
5. Calls `storage.getSomaQuestionById(questionId)`.
6. Returns `404 { message: "Question not found" }` when missing, wrapped by the global error envelope.
7. Calls `storage.getSomaQuiz(question.quizId)` to resolve the parent quiz.
8. Returns `403 { message: "Access denied" }` when the quiz is missing or `quiz.authorId !== tutorId`, wrapped by the global error envelope.
9. Calls `storage.deleteSomaQuestion(questionId)`.
10. Returns `{ success: true }`.

## Side effects

The route is pure question deletion from `soma_questions` through the storage interface. It does **not** directly update reports, submissions, assignments, review status, quiz metadata, storage objects, AI jobs, grading rows, or mastery data.

Any downstream UI/report changes are read-after-write effects caused by later queries seeing one fewer question. No storage cleanup is involved.

## Ownership model

Ownership is resolved server-side:

- The request supplies only `questionId`.
- The server loads the question.
- The server loads the parent quiz from `question.quizId`.
- The parent quiz `authorId` must equal the authenticated tutor id from middleware.
- Request-supplied `tutorId`, `authorId`, `quizId`, `role`, or student identifiers are not trusted.

## Storage methods used

- `storage.getSomaQuestionById(questionId)`
- `storage.getSomaQuiz(question.quizId)`
- `storage.deleteSomaQuestion(questionId)`

## Response shape and errors

Successful response remains exactly:

```json
{ "success": true }
```

Error statuses/messages remain:

- `400` — `Invalid question ID`
- `404` — `Question not found`
- `403` — `Access denied`
- `500` — existing internal error helper event/message: `routes.failed_to_delete_question` / `Failed to delete question`

The global error envelope in `registerRoutes` continues to wrap 4xx/5xx response bodies consistently.

## Intentionally deferred logic

Phase 7 does not migrate or alter:

- AI generation routes.
- AI copilot routes.
- Grading or structured marking.
- PDF AI marking.
- Examiner misconception extraction or linking.
- AI report diagnosis.
- Mastery update side effects.
- Student quiz submission.

This phase is intentionally narrow because question deletion is a non-AI tutor-management operation with a clear ownership boundary and no direct grading or AI side effects.
