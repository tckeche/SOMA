---
name: Supabase DB access in SOMA
description: How to query/mutate the app's real database, and what the Supabase-related secrets actually contain.
---

The SOMA app stores its data in **Supabase Postgres**, reached via a connection string, using the `pg` driver (`server/db.ts` reads `SUPABASE_DB_URL || SUPABASE_URL`).

**Pitfall:** the Replit-provided `executeSql` callback (in the code-execution sandbox) connects to Replit's **built-in Postgres**, which is a *different, empty* database. Querying app tables (`soma_users`, `soma_quizzes`, …) through `executeSql` returns 0 rows even when the data exists. To touch real app data, open a `pg.Pool` against the Supabase connection string instead.

**Secret shapes (non-obvious):**
- `SUPABASE_URL` — a **Postgres connection string** (`postgres://…@…pooler.supabase.com:6543/…`), NOT the REST API URL.
- `VITE_SUPABASE_URL` — the **REST API URL** (`https://<ref>.supabase.co`); use this for the `@supabase/supabase-js` admin client (e.g. `auth.admin.createUser` / `deleteUser`).
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key for the admin client.

**Why:** mixing these up wastes time — admin auth calls need the https URL, DB row work needs the connection string, and `executeSql` silently points at the wrong DB.

**How to apply:** for e2e account provisioning/cleanup, delete DB rows via `pg` on the connection string (FKs: `soma_questions` cascades from `soma_quizzes`; `soma_quizzes.author_id` is ON DELETE SET NULL so delete quizzes explicitly) and delete auth users via supabase-js admin on the https URL.

Also note `process.env` is unavailable inside the code-execution sandbox — run provisioning/cleanup node scripts via the shell where env vars resolve.
