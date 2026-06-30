# SOMA Phase 3 Migration Map

## Scope migrated

Phase 3 extracts medium-risk tutor assessment management endpoints from `server/routes.ts` into autoloaded domain modules while leaving high-risk AI generation, quiz publish, grading, structured marking, PDF AI marking, examiner misconception, and AI report diagnosis routes in the legacy bootstrap.

## Route clusters

- `tutorQuizzes`: tutor-owned quiz create, list, clone, detail, review, question review actions, metadata updates, archive, and delete.
- `quizAssignments`: assign, unassign/revoke, due date update, deadline extension, and assignment status list.
- `tutorReports`: read-only tutor quiz report listing.
- `tutorDashboard`: read-only tutor dashboard stats.
- `flaggedQuestions`: tutor-scoped flagged question listing and resolution.

## Routes intentionally left for later phases

- PDF worksheet attachments and student PDF submission upload/download/delete routes remain in `server/routes.ts` because they are tightly coupled to the existing upload middleware, storage guards, signed URL handling, and PDF AI marking surface. They should be migrated as a focused Phase 3b/Phase 4 file-storage batch with dedicated upload regression tests.
- Quiz drafts, quiz publish, generated assessment, add-question generation, grading, structured marking, PDF AI marking, and examiner misconception flows remain in `server/routes.ts` due to higher business and AI-risk.

## Preservation checks

- Tutor author ownership remains server-side for every migrated tutor quiz, assignment, report, and flagged-question route.
- Student pre-submission quiz questions continue to be sanitized by the legacy student quiz-taking surface.
- Deleting a quiz still attempts cleanup for associated worksheet/submission storage paths before removing quiz rows.
- Assignment due-date and deadline-extension response shapes are preserved.
