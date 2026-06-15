---
name: Bootstrap is the only DB migration path
description: migrations/*.sql are NOT auto-applied; the live DB schema is driven solely by BOOTSTRAP_QUERIES in server/bootstrap.ts.
---

# Bootstrap is the source of truth for live DB schema

The app does NOT run `migrations/*.sql` on startup. The only thing that runs
against the live Supabase DB on every boot is `BOOTSTRAP_QUERIES` in
`server/bootstrap.ts` (idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE
IF NOT EXISTS`). The `migrations/` folder and `drizzle-kit` are effectively
documentation/dev-only.

**Why:** A pull added structured-answer columns (quiz_mode, question_count,
structured_count on soma_quizzes; mark_scheme on soma_questions;
structured_marking, review_requested, review_request_note, review_requested_at
on soma_reports) to `shared/schema.ts` AND to `migrations/0011`+`0012` — but NOT
to `BOOTSTRAP_QUERIES`. Result: the live DB never got the columns, and any
SELECT touching them (e.g. `/api/student/dashboard`) returned 500. The server
still "boots clean" because `schemaVerifier` only hard-fails in production, so
dev silently runs on a drifted DB.

**How to apply:** Whenever you add a column/table to `shared/schema.ts` or a
`migrations/*.sql` file, you MUST also add a matching idempotent statement to
`BOOTSTRAP_QUERIES` in `server/bootstrap.ts`, then restart so it applies. If a
runtime 500 mentions a "column does not exist" that is declared in schema.ts,
the fix is almost always a missing bootstrap entry, not a code bug.
