# Phase 8 Migration Map — Student Quiz-Taking Read Boundary

## Phase 7 branch confirmation

The current branch includes the Phase 7 question-management extraction:

- `POST /api/tutor/quizzes/:quizId/questions` is manual tutor insertion in `server/modules/questionManagement`.
- `DELETE /api/tutor/questions/:questionId` is also owned by `server/modules/questionManagement`.
- Phase 8 starts from that modularized tutor question-management boundary and does not change it.

## Frontend consumer inspected

The quiz-taking page `client/src/pages/soma-quiz.tsx` loads three read endpoints before/around taking a quiz:

1. `GET /api/soma/quizzes/:id` for quiz metadata.
2. `GET /api/soma/quizzes/:id/questions` for the pre-submission question payload.
3. `GET /api/soma/quizzes/:id/check-submission` to determine whether the current student already submitted.

The same page submits answers through `POST /api/soma/quizzes/:id/submit`; that route performs marking/report side effects and remains intentionally out of scope for Phase 8.

The student PDF worksheet component separately loads `GET /api/quizzes/:quizId/attachments` through the already-extracted `pdfAttachments` module, so Phase 8 only preserves compatibility with that attachment visibility model and does not remigrate file routes.

## Routes discovered before editing

### `GET /api/soma/quizzes`

- Read-only.
- Mixed access: `super_admin` sees all non-archived quizzes; `tutor` sees authored non-archived quizzes; students see non-archived quizzes assigned to their authenticated user id.
- Uses `storage.getSomaQuizzes()` for admin/tutor and `storage.getQuizAssignmentsForStudent(authUserId)` for students.
- Response shape is an array of `SomaQuiz` rows.

### `GET /api/soma/quizzes/:id`

- Read-only.
- Mixed access: super admin, owning tutor, or assigned student.
- Invalid id returns `400 { message: "Invalid quiz ID" }`.
- Missing or archived quiz returns `404 { message: "Quiz not found" }`.
- Unauthorized access returns `403 { message: "Forbidden: you do not have access to this quiz" }`.
- Response shape is the raw quiz object.

### `GET /api/soma/quizzes/:id/questions`

- Read-only.
- Mixed access by the same quiz-read policy as quiz metadata.
- Invalid id returns `400 { message: "Invalid quiz ID" }`.
- Missing or archived quiz returns `404 { message: "Quiz not found" }`.
- Unauthorized access returns `403 { message: "Forbidden: you do not have access to this quiz" }`.
- Loads `storage.getSomaQuestionsByQuizId(id)`, filters with `isServableToStudent`, and returns sanitized pre-submission question rows.

### `GET /api/soma/quizzes/:id/check-submission`

- Read-only, but student-oriented.
- Uses the authenticated user id as the student id and calls `storage.checkSomaSubmission(quizId, studentId)`.
- Invalid id returns `400 { message: "quizId required" }`.
- Response shape is `{ submitted: boolean }`.
- The legacy route does not independently check assignment or archive state; Phase 8 preserves that response behaviour to avoid changing the quiz-taking page.

## Assignment access model

For quiz metadata and questions, access is resolved server-side:

- `super_admin` may read any non-archived quiz.
- `tutor` may read only quizzes where `quiz.authorId` equals the authenticated user id.
- students may read only quizzes present in `storage.getQuizAssignmentsForStudent(authenticatedUserId)`.
- Request-supplied `studentId`, `tutorId`, `role`, `authorId`, or `quizId` ownership claims are not trusted.

## Due date and archived quiz model

The discovered read routes do not enforce due dates or deadline cutoffs. They preserve the existing behaviour: assigned quizzes remain readable regardless of due date state. Archived or missing quizzes continue to return `404 { message: "Quiz not found" }` for the quiz metadata and question routes.

## Pre-submission visibility and sanitization model

The pre-submission question endpoint returns only student-safe fields:

- Preserved: `id`, `quizId`, `stem`, `options`, `marks`, `questionType`, and `graphSpec`.
- Omitted: `correctAnswer`, `explanation`, `optionRationales`, and `targetMisconceptionIds`.
- Tutor-only review metadata such as `reviewStatus` is not included.
- Questions blocked by the review gate are filtered out through `isServableToStudent`.

## Post-submission visibility model

Phase 8 does not migrate report review or submission routes. The only post-submission-adjacent route included here is the read-only `check-submission` endpoint, whose existing `{ submitted }` shape is preserved.

## Attachment visibility model

Worksheet attachment listing/download remains owned by the `pdfAttachments` module. Its public attachment projection already hides internal `storagePath` values, and Phase 8 tests verify the quiz-taking-adjacent student attachment payload remains available without leaking storage paths.

## Routes intentionally left in `server/routes.ts`

Phase 8 intentionally leaves these high-risk or side-effecting routes in the legacy file:

- `POST /api/soma/quizzes/:id/submit`.
- Student report/review routes.
- Grading and structured marking routes.
- PDF AI marking routes.
- Examiner misconception extraction/linking.
- AI report diagnosis.
- Mastery update side effects.
- Student notification creation after grading.

## Why grading and submission are deferred

The submission route validates answers, computes scores, creates reports, may interact with structured/PDF marking paths, and triggers downstream learning/reporting side effects. That is not a read boundary. Phase 8 extracts only the separable read endpoints needed for quiz loading and answer-key-safe pre-submission rendering.
