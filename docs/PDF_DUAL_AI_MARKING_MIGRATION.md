# PDF dual AI marking migration

Production schema authority is `BOOTSTRAP_QUERIES` in `server/bootstrap.ts`; fixture `migrations/0014_pdf_dual_ai_marking.sql` mirrors the same additive SQL for PGlite tests.

## New columns
- `soma_quizzes.pdf_marking_mode TEXT NOT NULL DEFAULT 'manual'`
- `assessment_attachments.document_role TEXT NOT NULL DEFAULT 'worksheet'`
- `submission_uploads.ai_marking_status TEXT NULL`
- `submission_uploads.submission_version INTEGER NOT NULL DEFAULT 1`
- `submission_uploads.content_hash TEXT NULL`

## New tables
- `pdf_assessment_configs`
- `pdf_marking_documents`
- `pdf_rubric_versions`
- `pdf_marking_jobs`
- `pdf_marking_runs`
- `pdf_marking_review_items`
- `pdf_marking_annotations`

## Indexes
Unique: `pdf_rubric_versions_quiz_version_idx`, `pdf_marking_jobs.idempotency_key`, `pdf_assessment_configs.quiz_id`.
Hot lookups: document quiz, job poll partial index, job submission, run submission/created, review item run, annotation run/submission.

## Verification queries
Run `npm run db:bootstrap` or `npm run db:verify-live`. Optional SQL checks: `select count(*) from pdf_marking_jobs;`, inspect `information_schema.columns` for the three altered tables, and verify `pg_indexes` contains the indexes above.

## Expected defaults
Existing PDF assessments resolve to manual. Existing attachments resolve to worksheet. Existing submissions have `submission_version = 1` and no AI status.

## Rollout
1. Deploy code with `PDF_DUAL_MARKING_ENABLED=false`.
2. Run `npm run db:bootstrap` in Replit against the production database.
3. Set two independent providers and models.
4. Enable `PDF_DUAL_MARKING_ENABLED=true`; enable worker only after provider health is confirmed.

## Non-destructive rollback
Set `PDF_DUAL_MARKING_ENABLED=false` and `PDF_MARKING_WORKER_ENABLED=false`. Manual PDF flow remains available. Do not drop tables; retain audit data and generated object references.
