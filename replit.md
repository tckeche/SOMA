# SOMA — Intelligent Assessment Platform

## Overview
SOMA is a full-stack intelligent assessment platform for school-level mathematics and science. It offers interactive MCQ quizzes with LaTeX rendering for students, an AI-powered copilot for tutors to create curriculum-aligned quizzes, and super-admin tools for user and content management. The platform's core purpose is to provide accurate and verifiable assessments by grounding all AI interactions in a structured, syllabus-aligned curriculum catalogue.

## User Preferences
I want the agent to focus on completing the assigned tasks.
I prefer to use a modern and efficient development workflow.
I appreciate clear and concise communication.
I want the agent to use proper Markdown formatting for all text.

## System Architecture

### UI/UX
The frontend uses React, Vite, Tailwind CSS, and Shadcn UI. Mathematical content is rendered via ReactMarkdown, remark-math, and rehype-katex. The tutor dashboard is plaque-first with flip animations.

The app uses **Premium design system v2** — a sharp, quiet, high-end aesthetic with crisp surfaces, refined low-spread shadows, the **Hanken Grotesk** / **JetBrains Mono** type pairing, and a dark-green brand. It is **true dual-theme** (dark is the default; a working toggle switches to a warm/white light mode), driven entirely by the Shadcn semantic-token layer in `client/src/index.css` (`:root`/`.light`/`.dark`) plus a clean brand-wash ground (no photo wallpaper). A semantic status vocabulary — `--success`/`--warning`/`--info` (+ soft/line surfaces) and `--destructive` — is registered in `tailwind.config.ts` as `success`/`warning`/`info`/`danger`, and reusable primitives live in `@layer components`: `glass-card`/`glass-panel-elite`/`stat-card`, `chip`(+`chip-success`/`-warning`/`-danger`/`-info`/`-brand`), `eyebrow`, `soma-display`, `num`, `meter`, `well`, `avatar`.

**Design rule — no raw Tailwind palette colors in component JSX.** Never write `text-violet-400`, `bg-amber-500/10`, `border-emerald-500/30`, etc. Route every semantic colour through tokens (`text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`, `text-primary`, and the `success`/`warning`/`info`/`danger` utilities) or the `chip-*` classes. Raw palette literals are allowed **only** for chart/data-viz series, categorical avatar palettes, and fixed-surface print/PDF views. A bridge block of `html.light .text-*`/`.bg-*` overrides in `index.css` keeps the few remaining intentional literals legible in light mode.

### Backend
The backend is built with Node.js and Express, utilizing Drizzle ORM with a PostgreSQL database (Supabase). Supabase Auth manages authentication with RBAC roles (`student`, `tutor`, `super_admin`). Frontend routing is handled by wouter.

### Curriculum Catalogue
A normalized curriculum catalogue (`examining_bodies` → `levels` → `subjects` → `syllabi` → `topics` → `subtopics` → `learning_requirements` → `competencies` → `papers`) acts as the central source for subject and syllabus context. This catalogue drives the AI pipeline through a `CatalogueCopilotContext` payload, ensuring syllabus alignment for AI-generated content.

The same catalogue acts as a closed-set constraint for the examiner-misconception extractor (`server/services/extractAndStoreMisconceptions.ts`). `catalogueInventory.ts` exposes `listAllowedTopicsForSyllabusCode` / `lookupInInventory`; the extractor injects `ALLOWED_TOPICS` into the prompt header and discards any item whose topic is outside the inventory (off-list subtopics get nulled, off-list topics increment `taxonomyDrops`). The legacy 3,485-row hallucination set (e.g. "Algebra" tagged onto Accounting paper 9706) has been replaced for every catalogued syllabus by `scripts/reextractExaminerMisconceptions.ts`, which deletes per-doc legacy rows and re-runs the closed-set extractor on `gpt-4o-mini` (~16× cheaper than gpt-4o, classification-only task). The script is resumable via the `source_quote IS NOT NULL` sentinel and refuses to drop a "done" sentinel for any doc whose chunks all errored, so transient LLM failures stay re-tryable. After the Group A re-extraction the table holds ~4,049 evidence-backed rows (`source_quote` populated) with ~3,788 linked to a real catalogue subtopic; the only remaining 315 legacy rows belong to the two syllabi with no catalogue topics yet — English 0500 (160) and ICT 0417 (155) — and stay untouched until those catalogues are built.

### Reference Text & Semantic Retrieval
The system builds and embeds reference text "chunks" per (topic, tier) using OpenAI's `text-embedding-3-small`. Semantic search, enhanced with lexical keyword boosting, filters these chunks. This mechanism auto-populates `selectedTopics` in AI prompts, providing explicit context to the LLM. A `stripSyllabusNoise` pre-processor cleans raw syllabus documents.

### AI Generation Pipeline
The AI pipeline employs a two-stage Maker → Verifier model, enforcing a no-self-grading rule (the model that drafts a question never grades it — provider exclusion is enforced in code). Pipeline model selection is centralised in `aiPipeline.ts` (`MODEL_CLAUDE`/`MODEL_OPENAI`/`MODEL_GEMINI`):
1.  **Maker**: Claude Opus 4.8 (with GPT-5 fallback) drafts MCQs without explanations.
2.  **Verifier**: GPT-5 at high reasoning effort (with Gemini 2.5 Flash fallback) verifies quizzes, fixes errors, and writes explanations. Gemini 2.5 Flash verifies GPT-5-generated quizzes.
3.  **Independent blind solver**: a third, provider-independent model (GPT-5 / Opus 4.8 / Gemini, excluding the maker's and checker's providers) re-answers non-math questions blind so the disagreement protocol can block an unverifiable answer key. `openAITuning()` centralises the reasoning-model parameter contract (GPT-5/o-series reject `temperature` → use `reasoning_effort`; Opus 4.8 rejects sampling params).
Deterministic guards (`applyDeterministicIntegrityGuards`, `validateAndCorrectMcqAnswers`, `applyMathValidatorCorrections`) ensure data integrity. Each surviving question carries a per-question independent-verification record (`verification[]`: `math_prover` / `blind_solver` / `none`); a question that nothing independent could confirm is routed to tutor review rather than auto-served. Progress and warnings are streamed via Server-Sent Events to the builder Co-Pilot. LaTeX corruption is handled by `sanitizeLatexBackslashes` and `repairControlCharCorruption`.

### Syllabus-Scope Gate
Generated questions are constrained to the syllabus both at the source and after the fact. The Maker prompt enumerates the catalogue's selected topics/subtopics and requires `topic_tag`/`subtopic_tag` to be copied verbatim from that closed set (prevention). After generation, `server/services/questionScope.ts` (`assessTopicScope` + `resolveReviewStatus`) classifies each question's tags against the catalogue inventory (`listAllowedTopicsForSyllabusCode`): off-topic questions are downgraded to `needs_review` so they are never silently served, off-subtopic drift is surfaced as a warning, and an uncatalogued syllabus is a no-op. The gate is applied on all three write paths (tutor-generate, soma-generate, builder publish — the publish path now persists `reviewStatus`, closing a hole where flagged questions previously shipped as `approved`). Generate/publish responses return a `reviewSummary` (servable / needsReview / autoBlocked) so any withheld-question shortfall is visible rather than silent.

### Syllabus Insights
The `syllabusInsights.ts` service generates per-student topic-coverage radar and paper-readiness heatmaps based on student reports and the Cambridge syllabus catalogue, displayed on student and tutor dashboards.

### Tutor Builder & Copilot
The Tutor Portal features a Command Centre dashboard and an AI Copilot (Builder). This catalogue-driven wizard assists tutors in creating quizzes, saving drafts until publication. AI Dashboard Intelligence synthesizes assessment data into narratives and identifies weaknesses. The intervention-queue insights (`POST /api/tutor/ai/intervention-insights`) are grounded in *specific* evidence: the endpoint enriches each at-risk student with real weak topics/subtopics (from `student_topic_mastery`, tested rows under 60% understanding) and weak papers (from `buildSyllabusInsights`, low-readiness papers), so the narrative names the topic, subtopic, and paper a student is struggling with (e.g. "struggling with Integration for Paper 1 Maths, particularly the constant of integration") rather than just the subject. The prompt forbids fabricating any topic/subtopic/paper not present in the payload and falls back to subject-level data when granular mastery is absent. Authorization is enforced server-side — only students adopted by the requesting tutor are enriched; client-supplied `studentId`s outside that set are dropped.

### Assessment Type (Delivery Format)
Each assessment carries a `format` column on `soma_quizzes` (`'mcq'` default, or `'pdf'`), chosen up front in the AssessmentWizard before building. The type is locked once the quiz row exists. For `mcq` the build runs the normal Co-Pilot → draft → Preview/Review → publish flow. For `pdf` the Co-Pilot panel is replaced by `TutorWorksheetManager` (worksheet PDF upload/list/delete via `/api/tutor/quizzes/:quizId/attachments`); publishing skips the empty-draft and 4-option MCQ gates and persists with zero questions. Students see a worksheet-download + PDF-response upload screen (`StudentAssessmentPdfSection`) instead of the MCQ engine, with no timer. The builder exposes a LaTeX-rendered **Review** modal (`QuestionReviewList` via `MarkdownRenderer`) next to **Preview** for mcq assessments; the published/pending review page (`TutorQuizReview`) renders question content through `MarkdownRenderer` as well. The Assessment Bank shows a type badge and supports deletion per assessment.

### Student Experience
The Soma Quiz Engine provides a LaTeX-aware MCQ player and a summary view. The Soma Quiz Review offers post-quiz analysis, including explanations and AI feedback.

### Authentication System
A single portal-aware `/login` route manages tab-based login, signup, and forgot-password with inline error handling. The `?portal=tutor|student` query param (parsed via wouter `useSearch`, default `student`) selects the entry point: the heading, switch-portal link, and signup account type lock to the portal. Login is gated on the resolved role — the tutor portal accepts `tutor`/`super_admin`, the student portal only `student`; a mismatch signs the user out and shows an error. Landing CTAs route to `/login?portal=student` and `/login?portal=tutor`.

### Written-Answer (Structured) Feedback Surfacing
Structured (non-MCQ) questions are AI-marked at submission time and stored on `soma_reports.structuredMarking[qid]` (`{ aiMarks, maxMarks, aiFeedback, aiUnderstanding, tutorMarks }`). A shared helper `server/services/structuredFeedback.ts` (`buildStructuredFeedback`) reads these reports + `soma_questions` (topicTag/subtopicTag/stem), computes the effective mark (`tutorMarks ?? aiMarks`), filters weak answers (percent < 60), and returns them sorted recent-then-weakest. The two qualitative fields map to **whereFailing** (`aiUnderstanding` — where the answer fell short) and **howToImprove** (`aiFeedback` — corrective guidance). **No new AI calls are made** — this only surfaces marking data already captured. The helper is the single source feeding three surfaces consistently: (1) the tutor intervention queue (`POST /api/tutor/ai/intervention-insights`) injects per-student `structuredWeakAnswers` (top 3) into the prompt so the narrative names written-answer gaps without fabrication; (2) the tutor student report (`GET /api/tutor/students/:studentId/report`) returns `structuredFeedback` (limit 12), rendered LaTeX-aware via `MarkdownRenderer` in `TutorStudentDetail.tsx`; (3) the student dashboard (`GET /api/student/dashboard`) attaches `structuredFeedback` (limit 8), rendered as a "Your written answers" block in `StudentDashboard.tsx` alongside the existing subject/topic FocusBlock and paper-readiness syllabus insights.

### Database Migrations Policy
The production schema is managed by `BOOTSTRAP_QUERIES` in `server/bootstrap.ts`, which runs idempotently on every server start. `server/schemaVerifier.ts` validates the live DB against `shared/schema.ts` at startup, failing in production if schema declarations are missing from the database.

## External Dependencies
-   **Auth**: Supabase Auth
-   **AI/LLM Providers**: Google Generative AI (Gemini 2.5 Flash), Anthropic AI SDK (Claude Opus 4.8, Claude Haiku 4.5), OpenAI (GPT-5, GPT-4o, GPT-4o-mini, `text-embedding-3-small`), DeepSeek
-   **Database**: PostgreSQL (Supabase)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, Vite, Tailwind CSS, Shadcn UI, react-katex, DOMPurify, wouter
-   **Backend Libraries**: Node.js, Express, multer, pdf-parse, drizzle-orm
-   **Testing**: Vitest