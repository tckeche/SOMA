# SOMA Performance Audit — 2026-06-15

Why the app feels heavy and slow to load, what's been fixed in this PR, and what
to do next. Findings are evidence-backed with `file:line` references and ordered
by impact.

---

## TL;DR

The slowness comes from three compounding causes:

1. **The whole app shipped in one JS bundle.** Every one of the 19 pages — plus
   their heavy libraries (markdown/KaTeX, charts, the PDF stack, animations) —
   was statically imported at startup, so the browser downloaded and parsed all
   of it before the first screen could render.
2. **Login lands behind a request waterfall.** Reaching a dashboard waits for the
   Supabase session, *then* a second `/api/auth/me` round-trip for the role,
   *then* the page's own 5–8 queries — several of which wait on each other.
3. **Hot database reads were doing sequential scans + N+1 query loops.** The
   busiest foreign-key columns (`soma_reports.student_id`, `soma_questions.quiz_id`,
   etc.) had no index, and several tutor/dashboard endpoints issue one query
   *per assignment / per student / per subject* in a loop.

This PR ships the **safe, mechanical wins** (1 partially, plus the indexes) and
documents the rest as scoped follow-ups.

---

## ✅ Fixed in this PR

| Change | File | Effect |
|--------|------|--------|
| **Route-level code splitting** — all 17 non-trivial pages are now `React.lazy()` behind a `<Suspense>` boundary | `client/src/App.tsx` | The initial download is now just the app shell + the one page you land on. Heavy per-page deps (KaTeX, charts, PDF) no longer load until their page does. |
| **Vendor chunk splitting** — `manualChunks` isolates `charts`, `markdown`/katex, `pdf`, `motion`, `supabase` | `vite.config.ts` | Those libs become independent, lazily-loaded, independently-cached chunks instead of being fused into the main bundle. |
| **5 hot-path indexes** on unindexed FK columns | `shared/schema.ts`, `migrations/0013_perf_indexes.sql` | Removes sequential scans from the student/tutor dashboard, quiz reads, and notifications. |

Indexes added: `soma_questions(quiz_id)`, `soma_reports(student_id)`,
`soma_reports(quiz_id)`, `quiz_assignments(student_id)`,
`student_notifications(student_id, created_at)`.
(`student_topic_mastery` is already covered by its existing composite unique
index, which is led by `student_id`.)

> Apply with `npm run db:push` (or run `migrations/0013_perf_indexes.sql`). The
> index DDL is `IF NOT EXISTS`, so it's safe to re-run.

---

## Client-side findings

### C1 — One monolithic bundle (FIXED)
`client/src/App.tsx:6-24` statically imported all 19 pages. Pages like
`builder.tsx` (~1.8k lines), `TutorDashboard.tsx` (~1.6k), and
`TutorAssessments.tsx` (~1.6k) were parsed up front even when unused. **Fixed**
via `React.lazy` + `Suspense`.

### C2 — Auth waterfall before any dashboard (recommended)
`client/src/components/RoleRouter.tsx:17-35`: after the Supabase session
resolves, RoleRouter fires a **second** blocking `authFetch("/api/auth/me")` to
learn the role, showing a spinner the whole time. `ProtectedRoute.tsx` adds its
own session-gated spinner. Net: two serial round-trips (~0.4–1.5s of blank
"Loading…") on every portal/dashboard entry.
**Fix:** cache the role for the session (TanStack Query keyed by user id, or
`sessionStorage`) so it's fetched once; better still, put the role in the
Supabase JWT/app_metadata and skip `/api/auth/me` entirely.

### C3 — Heavy libs were eager (mostly resolved by C1 + chunking)
- `framer-motion` (~40KB) — `TutorDashboard.tsx:4`, used only for fade-in polish.
  Consider replacing with Tailwind `animate-*` utilities already in the bundle.
- `recharts` (~100KB) + `dashboard-charts.tsx` (~666 lines) — eagerly imported in
  `TutorDashboard.tsx`, but charts live in tabs many tutors never open. Lazy-load
  the chart components on tab activation (`React.lazy`) so the `charts` chunk only
  loads on demand.
- `react-markdown` + remark/rehype + KaTeX + DOMPurify (~210KB) — used only when
  rendering questions/feedback. Now in the `markdown` chunk; ensure the renderer
  component itself is only imported by quiz/review pages (it is).
- PDF stack (`html2pdf`/`jspdf`/`html2canvas`) — already dynamically imported on
  the download click (`SomaQuizReview.tsx`), now also chunk-isolated.

### C4 — Dashboard query waterfalls (recommended, needs server help)
- `TutorDashboard.tsx:245-263`: the `aiInsights` query is `enabled` only after the
  `stats` query returns (its key derives from `stats.studentInsights`). Two serial
  fetches. **Fix:** return `{ stats, aiInsights }` from one endpoint.
- `StudentDashboard.tsx:118-134`: the dashboard query resolves, then `useQueries`
  fires **4 parallel** `/api/student/study-tips?subject=X` calls. **Fix:** fold the
  tips into the `/api/student/dashboard` payload.

### C5 — Large page components (follow-up)
`TutorAssessments.tsx`, `TutorDashboard.tsx`, `builder.tsx` are each ~1.6–1.8k
lines. Beyond bundle size this means big render/reconcile costs. Splitting into
sub-components (and lazy sub-sections) reduces re-render churn. Lower priority
than C2/C4.

---

## Server-side findings

### S1 — Missing indexes on hot FK columns (FIXED)
`shared/schema.ts`: `soma_reports.student_id`, `soma_reports.quiz_id`,
`soma_questions.quiz_id`, `quiz_assignments.student_id`, and
`student_notifications.student_id` were unindexed despite being the filter/join
keys for the dashboards and quiz reads. Each dashboard load did sequential scans.
**Fixed** (migration 0013).

### S2 — N+1: questions fetched per assignment (recommended)
`server/routes.ts:~3844`, `~4070`, `~7317` follow the pattern:
```js
await Promise.all(assignments.map(async (a) => {
  const questions = await storage.getSomaQuestionsByQuizId(a.quizId); // 1 query each
}));
```
A student with N assignments ⇒ N round-trips; a tutor viewing M students ⇒ M×N.
**Fix:** add `storage.getSomaQuestionsByQuizIds(quizIds: number[])` (one
`WHERE quiz_id = ANY($1)` query) and group in memory. This is the single biggest
server win after the indexes.

### S3 — N+1: per-subject syllabus inventory (recommended)
`server/routes.ts:~4098` and `server/services/syllabusInsights.ts:~90` loop
`listSyllabusTopicInventory({...})` once per enrolled subject. **Fix:** accept an
array of (board, syllabusCode, subject) filters and run one query.

### S4 — N+1: per-submission user lookup (recommended)
`server/routes.ts:~3162` calls `getSomaUserById(row.studentId)` inside a `map`.
**Fix:** `getSomaUsersByIds(ids)` once before the loop.

### S5 — `buildStudentDashboard` recomputed multiple times (recommended)
`/api/student/performance` and `/api/student/syllabus-coverage`
(`server/routes.ts:~5804-5833`) each call `buildStudentDashboard` again just to
extract a slice. **Fix:** have the client read those slices from the single
`/api/student/dashboard` response, or add a short-lived request/session cache.

### S6 — AI on the request path (verified OK)
The multi-second `generateWithFallback` calls are confined to
generate/copilot/grading/spellcheck endpoints — **not** to navigation/load
endpoints. Structured marking runs as a background task. No action needed.

---

## Recommended rollout order (post-merge)

1. **Done here:** indexes + route splitting + vendor chunks. Re-run
   `npm run build` and compare `dist/public` chunk sizes; throttle to Slow 3G in
   DevTools and compare FCP/TTI for the dashboards.
2. **Batch the N+1s (S2 → S4):** add `getSomaQuestionsByQuizIds` /
   `getSomaUsersByIds` and the array-filter inventory query. ~half a day, high ROI.
3. **Kill the auth waterfall (C2):** role in JWT or a cached role query.
4. **Consolidate dashboard endpoints (C4, S5):** one fetch per dashboard.
5. **Lazy-load charts + drop framer-motion (C3, C5):** trims the heaviest
   remaining client chunks.

Expected combined effect: the agents' analysis points to a **~2–4s faster
first paint** on the client and **~60–75% lower dashboard query time** on the
server once the indexes and N+1 batching land.

---

## Verification checklist

- [ ] `npm run check` (types), `npm test`
- [ ] `npm run db:push` to create the new indexes
- [ ] `npm run build`; confirm the entry chunk shrank and `markdown`/`charts`/`pdf`
      chunks exist separately
- [ ] DevTools Network on Slow 3G: dashboards should paint the shell before the
      page chunk finishes; only the visited page's chunk downloads
- [ ] `EXPLAIN` a student-dashboard report query to confirm index usage
