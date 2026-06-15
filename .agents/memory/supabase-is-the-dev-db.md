---
name: SOMA dev database is Supabase, not Replit Postgres
description: Why the built-in SQL tool shows an empty DB while the app's real data lives in Supabase
---

The SOMA app connects to **Supabase Postgres** via the `SUPABASE_URL` / `SUPABASE_DB_URL` connection string (and Supabase Auth via `VITE_SUPABASE_*`). The app is fully populated there (tens of students/tutors, hundreds of quizzes/assignments/reports, thousands of questions).

**Why this matters:** Replit's built-in `execute_sql` tool and the default `DATABASE_URL` point at Replit's *own* built-in Postgres, which for this project is **empty / out of sync**. Querying it gives the false impression that the database is empty or that columns (e.g. `soma_quizzes.format`) are missing. They are NOT missing in the real DB.

**How to apply:** To inspect real app data, run a node script via `bash` (the code_execution sandbox has no `process.env`) using a `pg.Pool` built from `SUPABASE_DB_URL`/`SUPABASE_URL` with `ssl:{rejectUnauthorized:false}`, stripping any `sslmode=` query param. Never trust `execute_sql`/built-in Postgres for this project's data state. Keep all queries against production data read-only.
