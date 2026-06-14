---
name: Database access (Supabase vs Replit Postgres)
description: Which DB the app uses and why the executeSql tool can't see its data
---

# App data lives in Supabase, not Replit's built-in Postgres

The SOMA app connects to **Supabase** (env: `SUPABASE_URL`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`). All application tables (e.g. `examiner_misconceptions`)
live there.

The `executeSql` code-execution callback / database skill talks to Replit's
**built-in** Postgres (`DATABASE_URL`), which is a *different, near-empty* DB.

**Why it matters:** Querying app tables via `executeSql` fails with
"column/relation does not exist" or returns empty — it is NOT evidence the app
data is missing or the schema is wrong. It's just the wrong database.

**How to apply:** To verify live app data, go through Supabase (Supabase client
with the env creds, or the app's own storage/queries) — never `executeSql`.
Trust `replit.md`'s documented end-state for historical data counts.
