# SOMA Phase 4 Migration Map

## Scope

Phase 4 migrates the remaining non-AI PDF file-storage surface out of `server/routes.ts` into autoloaded domain modules. The migration is limited to worksheet attachments, student PDF submission uploads/status, signed downloads, storage configuration guards, upload validation, public response sanitization, and shared storage cleanup helpers.

## Domains to extract

- `fileStorageAccess`: shared PDF upload middleware, PDF magic-byte validation, storage configuration guard, response sanitizers, and quiz storage cleanup helpers used by PDF domains and quiz deletion.
- `pdfAttachments`: tutor worksheet upload/list/delete and assigned-user worksheet list/download routes.
- `pdfSubmissions`: student PDF response upload/status and tutor submission list/download routes.

## Routes to migrate

- `POST /api/tutor/quizzes/:quizId/attachments`
- `GET /api/tutor/quizzes/:quizId/attachments`
- `DELETE /api/tutor/quizzes/:quizId/attachments/:attachmentId`
- `GET /api/quizzes/:quizId/attachments`
- `GET /api/quizzes/:quizId/attachments/:attachmentId/download`
- `POST /api/quizzes/:quizId/submission-upload`
- `GET /api/quizzes/:quizId/submission-upload`
- `GET /api/tutor/quizzes/:quizId/submission-uploads`
- `GET /api/tutor/submission-uploads/:id/download`

## Routes intentionally left in legacy

- `POST /api/tutor/submission-uploads/:id/mark` remains in `server/routes.ts` because it is manual marking/grading behaviour, not file-storage access.
- AI quiz generation, quiz publish, grading, structured marking, PDF AI marking jobs, examiner misconception extraction/linking, AI report diagnosis, and mastery update logic remain deferred.

## Preservation requirements

- Keep the 20MB multer cap, `application/pdf` MIME check, and `%PDF-` magic-byte validation.
- Keep storage-unconfigured responses as `{ message: "File storage is not configured" }` with status 503.
- Keep signed URL responses as `{ url }`.
- Never expose `storagePath` or `annotatedStoragePath` in public attachment/submission payloads.
- Preserve tutor ownership, assigned-student access, format checks, Supabase storage cleanup ordering, and existing 400/403/404/502 response messages.
