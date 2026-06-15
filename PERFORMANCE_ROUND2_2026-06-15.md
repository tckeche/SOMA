# SOMA Performance — Round 2 (2026-06-15)

Follow-up to `PERFORMANCE_AUDIT_2026-06-15.md`. This round eliminates the
server-side N+1 query loops (the biggest remaining win after the indexes) and
catalogues the leftover items, separating "safe to ship now" from "needs a new
dependency / product decision".

## ✅ Fixed in this PR — N+1 query elimination

Four hot endpoints fetched questions **one quiz at a time inside a loop**
(`getSomaQuestionsByQuizId` per assignment / per report). For a student with N
assignments that's N round-trips; a tutor viewing many students multiplied it.
All four now batch into a **single** query and group in memory:

| Endpoint | File:line | Before | After |
|----------|-----------|--------|-------|
| `/api/tutor/students/:id/performance` | `server/routes.ts:~3799` | 1 query/report | 1 batched `getSomaQuestionTotalsByQuizIds` |
| `/api/tutor/students/:id/report` | `server/routes.ts:~3828` | 1 query/assignment | 1 batched totals |
| student suggested-assessments analysis | `server/routes.ts:~4056` | 1 query/assignment | 1 batched `getSomaQuestionsByQuizIds` |
| dashboard misconception feedback | `server/routes.ts:~7306` | 1 query/report | 1 batched totals |

New storage method: **`getSomaQuestionsByQuizIds(quizIds): Record<quizId, SomaQuestion[]>`**
(`server/storage.ts`) — one `WHERE quiz_id = ANY($1)` query, grouped by quiz.
Three of the four sites only needed total marks, so they reuse the existing
`getSomaQuestionTotalsByQuizIds` (a single `GROUP BY` query). Behaviour is
identical — same data, far fewer round-trips. Combined with the FK indexes
shipped last round, these endpoints should drop from O(N) queries to O(1).

## Already in good shape (verified, no change needed)

- **TanStack Query defaults** (`client/src/lib/queryClient.ts`): `staleTime`
  5 min, `refetchOnWindowFocus: false`, `refetchInterval: false`. Sensible — no
  redundant refetch storm from the defaults.
- **AI on the request path**: confined to generate/copilot/grading/spellcheck;
  navigation/load endpoints don't block on AI.

## ⚠️ Recommended next — needs a dependency or a product call

1. **Gzip/Brotli compression is missing** (highest remaining win, but needs a
   dep). There is no `compression` middleware on the Express app, so JSON
   dashboard payloads and the built JS are served uncompressed. Add it:
   ```bash
   npm i compression && npm i -D @types/compression
   ```
   ```ts
   import compression from "compression";
   app.use(compression());
   ```
   Not done here because the package isn't installed and CI runs `npm ci`
   (lockfile-frozen) — adding the import without the lockfile entry would break
   the build. Land it in a small dedicated change that also updates the lockfile.

2. **Per-subject N+1 on syllabus inventory** (`server/routes.ts:~4083`,
   `server/services/syllabusInsights.ts`): `listSyllabusTopicInventory({...})`
   is called once per enrolled subject. Low impact (2–4 subjects/student) but
   easy to batch into one `WHERE (board,code) IN (...)` query.

3. **Aggressive polling intervals are a UX/product decision, not a bug.**
   `StudentDashboard` polls every 10s; `TutorAssessments` / SuperAdmin pages
   poll several queries every 15s. `realtimeEvents` is a **same-tab** event bus,
   not a server push, so this polling is the only mechanism that surfaces *other
   users'* changes. The N+1 fixes above make each poll much cheaper; if cross-
   client latency tolerance allows, relaxing these to 30–60s would further cut
   server load — but that trades off freshness, so it's left to the team.

4. **Role-resolution waterfall** (`client/src/components/RoleRouter.tsx`):
   still does `session → /api/auth/me` serially on `/portal` and `/dashboard`.
   Cache the role (TanStack Query keyed by user id, or put it in the Supabase
   JWT/app_metadata) to drop the second blocking round-trip on entry.
