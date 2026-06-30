# SOMA Architecture Migration Map

## Architecture diagnosis

- **Backend stack:** Express 5 on TypeScript/Node, Supabase JWT auth, Drizzle/PostgreSQL, multer, express-rate-limit, AI orchestration services, PDF parsing/storage, and worker-backed PDF marking. Boot remains `server/index.ts -> registerRoutes(httpServer, app)` after DB connection, storage init, bootstrap migrations, and PDF worker startup.
- **Frontend stack:** React 18, Vite, Wouter, React.lazy/Suspense route splitting, TanStack Query, Tailwind, Radix UI primitives, Recharts, KaTeX/Markdown, and custom SOMA tokens in `client/src/index.css`.
- **Already extracted route domains:** mastery map, command words, cohort heatmap, revision plans, super-admin AI usage, super-admin diagnostics, PDF AI marking, examiner insights review, tutor examiner insights, and mark-loss prediction.
- **Domains still trapped in `server/routes.ts`:** uploads/file serving, client error reports, graph rendering, auth sync/me/password/verification, tutor/student relationships, tutor quizzes, assignment management, quiz drafts/publish, quiz taking/submission, grading, structured marking, reports, dashboards, notifications, syllabus catalogue/document ingestion, examiner misconceptions, PDF attachments/submissions, super-admin users/quizzes/stats/tutor detail, legacy admin, AI generation/copilot/chat, and health-adjacent trace support.
- **Business logic in route handlers:** quiz ownership gates, adoption checks, assignment status, publish quality gates, student answer sanitization, AI prompt construction, grading workflows, PDF upload workflow, Supabase object cleanup, notification mutations, dashboard aggregation, syllabus catalogue filtering, and structured feedback orchestration are still inline in many legacy handlers.
- **Inline/duplicated validation:** many handlers define local Zod schemas or parse primitive params manually; upload MIME/size checks are split across multiple multer instances; `studentId`/`quizId` parsing and body normalization recur throughout the monolith.
- **Authorization risks:** `requireTutor`, `requireSuperAdmin`, and `requireSupabaseAuth` are shared, but route handlers repeatedly re-check `authorId`, adopted-student access, student ownership, and super-admin access inline, increasing drift risk.
- **File upload/storage embedded in routes:** image upload validation, syllabus PDF ingestion, tutor worksheet attachments, student PDF submissions, signed downloads, and storage deletion are route-local workflows.
- **AI/grading embedded in routes:** generation, copilot, global tutor chat, structured answer grading, report diagnosis, misconception extraction, and feedback generation are orchestrated directly by route handlers.
- **Frontend layout risks:** pages use mixed fixed widths/heights, dashboard grids without a shared container contract, table overflow inconsistently, and long syllabus/student/file labels can stress flex rows, cards, modals, charts, and quiz content.
- **Existing tests to preserve:** route integration, auth, storage, upload, PDF marking contracts, quiz ownership IDOR, answer-key guards, sanitization, dashboard links, AI pipeline/orchestrator/cache/budget/model policy, syllabus normalizer/catalogue, graph renderer/engine, and schema tests.

## Proposed migration order

1. Introduce the domain module contract and filesystem autoloader while keeping `registerRoutes(httpServer, app)` compatibility.
2. Extract shared route utilities (`asyncHandler`, upload validation, parse helpers, ownership helpers, response/error helpers) without moving behavior.
3. Move low-risk domains first: graph rendering, client error reporting, auth me/sync/password verification, catalogue reads, notifications, comments, and student subjects.
4. Move medium-risk tutor quiz/assignment/report/dashboard/PDF attachment flows after tests pin ownership and response shapes.
5. Move high-risk draft/publish/generation/grading/structured marking/examiner workflows only after domain tests exist.
6. Add frontend layout primitives, then migrate pages incrementally from dashboards outward.
7. Add syllabus display integrity helpers/diagnostics and update all catalogue/topic consumers.
8. Reduce `server/routes.ts` to bootstrap-only once all handlers are extracted.
