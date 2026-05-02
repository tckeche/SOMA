# `migrations/` — test fixture, **not** the runtime authority

> **TL;DR** These files are **never executed at server startup** in
> development or production. Editing them does not change the live database.
> The runtime authority for the production schema is the
> `BOOTSTRAP_QUERIES` array in [`server/bootstrap.ts`](../server/bootstrap.ts).

## Why this folder exists

The `*.sql` files here are the SQL fixture replayed by the PGlite-backed
integration test harness in [`tests/helpers/pglite.ts`](../tests/helpers/pglite.ts).
That harness reads `migrations/meta/_journal.json` and applies the listed
files in order to spin up a hermetic in-process Postgres for service-level
tests (e.g. `tests/examinerInsightsReviewQueue.pg.test.ts`).

Historically this folder also looked like a real Drizzle migration system —
hence the `_journal.json` file and the numbered SQL files. Production has
**never** consumed it: `server/index.ts` calls `applyBootstrapMigrations()`,
which only runs `BOOTSTRAP_QUERIES`. Adding a column here without also
adding a matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` to
`BOOTSTRAP_QUERIES` is what caused the `option_rationales does not exist`
production outage that motivated this README.

## What to do when the schema changes

1. Edit `shared/schema.ts` (the source of truth for column definitions).
2. Add a matching idempotent statement to `BOOTSTRAP_QUERIES` in
   `server/bootstrap.ts`. **Forgetting this step is now caught at startup
   by `verifySchemaMatchesDb()` — the server refuses to boot in production
   if `shared/schema.ts` declares anything the live DB doesn't have.**
3. If the change is also exercised by a PGlite-backed integration test,
   add a new `migrations/NNNN_*.sql` and register it in `meta/_journal.json`.
   (If your change is not covered by a `*.pg.test.ts`, you can skip this.)

## Why we don't auto-run migrations on startup

The migrations folder is incomplete relative to `shared/schema.ts` —
several tables and columns the application relies on were only ever added
to `BOOTSTRAP_QUERIES` (see the comments in `server/bootstrap.ts`). Wiring
the migrations folder into startup today would silently drop columns from
production. Until someone takes on the project of generating a single
clean baseline migration that exactly matches the live DB, the bootstrap
list is the authority and this folder is test-data.
