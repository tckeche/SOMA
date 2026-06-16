---
name: Tutor dashboard-stats N+1 + cross-region DB latency
description: Why per-student loops in storage are dangerous here, and the batch-then-bucket pattern to fix them.
---

# Dashboard perf: N+1 loops amplified by cross-region Supabase

The Supabase Postgres pooler lives in `aws-1-eu-central-1` (port 6543, pgBouncer
transaction pooler). Every individual query pays a cross-region round-trip
(~100-200ms), so any `for (const x of ids) { await db.query }` loop in
`server/storage.ts` turns into seconds of wall time.

**Symptom seen:** `GET /api/tutor/dashboard-stats` took ~3s while sibling endpoints
were ~400ms. Root cause was `getDashboardStatsForTutor` running 3 queries PER adopted
student (student record + assignments + reports) inside a `for (const sid of adoptedIds)`
loop. The Tutor dashboard also polls this endpoint on a 15s `refetchInterval`, so the
3s cost was paid continuously and made the whole app feel locked up.

**Fix pattern (batch-then-bucket):** replace per-id queries with ONE query using
`inArray(col, ids)` for each table, run the independent batch queries in `Promise.all`,
then bucket rows into `Map<studentId, rows[]>` in memory and iterate. Preserve any
per-id `LIMIT n` by sorting in the query (`orderBy(desc(createdAt))`) and slicing each
bucket in memory.

**Why:** collapses (1 + 3N) round-trips to ~4 regardless of cohort size.

**Still outstanding (same bug class, lower priority — super-admin only):**
`getTutorDashboardSummaries` (DatabaseStorage) loops per tutor running ~3 queries each.
Apply the same batch-then-bucket fix if the super-admin dashboard feels slow.
