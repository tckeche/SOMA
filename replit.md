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
The frontend uses React, Vite, Tailwind CSS, and Shadcn UI. Mathematical content is rendered via ReactMarkdown, remark-math, and rehype-katex. The design incorporates glassmorphism and features a plaque-first tutor dashboard with flip animations.

### Backend
The backend is built with Node.js and Express, utilizing Drizzle ORM with a PostgreSQL database (Supabase). Supabase Auth manages authentication with RBAC roles (`student`, `tutor`, `super_admin`). Frontend routing is handled by wouter.

### Curriculum Catalogue
A normalized curriculum catalogue (`examining_bodies` → `levels` → `subjects` → `syllabi` → `topics` → `subtopics` → `learning_requirements` → `competencies` → `papers`) acts as the central source for subject and syllabus context. This catalogue drives the AI pipeline through a `CatalogueCopilotContext` payload, ensuring syllabus alignment for AI-generated content.

The same catalogue acts as a closed-set constraint for the examiner-misconception extractor (`server/services/extractAndStoreMisconceptions.ts`). `catalogueInventory.ts` exposes `listAllowedTopicsForSyllabusCode` / `lookupInInventory`; the extractor injects `ALLOWED_TOPICS` into the prompt header and discards any item whose topic is outside the inventory (off-list subtopics get nulled, off-list topics increment `taxonomyDrops`). The legacy 3,485-row hallucination set (e.g. "Algebra" tagged onto Accounting paper 9706) is being replaced by `scripts/reextractExaminerMisconceptions.ts`, which deletes per-doc legacy rows and re-runs the closed-set extractor on `gpt-4o-mini` (~16× cheaper than gpt-4o, classification-only task). The script is resumable via the `source_quote IS NOT NULL` sentinel and refuses to drop a "done" sentinel for any doc whose chunks all errored, so transient LLM failures stay re-tryable.

### Reference Text & Semantic Retrieval
The system builds and embeds reference text "chunks" per (topic, tier) using OpenAI's `text-embedding-3-small`. Semantic search, enhanced with lexical keyword boosting, filters these chunks. This mechanism auto-populates `selectedTopics` in AI prompts, providing explicit context to the LLM. A `stripSyllabusNoise` pre-processor cleans raw syllabus documents.

### AI Generation Pipeline
The AI pipeline employs a two-stage Maker → Verifier model, enforcing a no-self-grading rule:
1.  **Maker**: Claude Sonnet 4.6 (with GPT-4o fallback) drafts MCQs without explanations.
2.  **Verifier**: GPT-4o (with Gemini 2.5 Flash fallback) verifies quizzes, fixes errors, and writes explanations. Gemini 2.5 Flash verifies GPT-4o generated quizzes.
Deterministic guards (`applyDeterministicIntegrityGuards`, `validateAndCorrectMcqAnswers`, `applyMathValidatorCorrections`) ensure data integrity. Progress and warnings are streamed via Server-Sent Events to the builder Co-Pilot. LaTeX corruption is handled by `sanitizeLatexBackslashes` and `repairControlCharCorruption`.

### Syllabus Insights
The `syllabusInsights.ts` service generates per-student topic-coverage radar and paper-readiness heatmaps based on student reports and the Cambridge syllabus catalogue, displayed on student and tutor dashboards.

### Tutor Builder & Copilot
The Tutor Portal features a Command Centre dashboard and an AI Copilot (Builder). This catalogue-driven wizard assists tutors in creating quizzes, saving drafts until publication. AI Dashboard Intelligence synthesizes assessment data into narratives and identifies weaknesses.

### Student Experience
The Soma Quiz Engine provides a LaTeX-aware MCQ player and a summary view. The Soma Quiz Review offers post-quiz analysis, including explanations and AI feedback.

### Authentication System
A single `/login` route manages tab-based login, signup, and forgot-password functionalities with inline error handling.

### Database Migrations Policy
The production schema is managed by `BOOTSTRAP_QUERIES` in `server/bootstrap.ts`, which runs idempotently on every server start. `server/schemaVerifier.ts` validates the live DB against `shared/schema.ts` at startup, failing in production if schema declarations are missing from the database.

## External Dependencies
-   **Auth**: Supabase Auth
-   **AI/LLM Providers**: Google Generative AI (Gemini), Anthropic AI SDK (Claude), OpenAI (GPT-4o, GPT-4o-mini, `text-embedding-3-small`), DeepSeek
-   **Database**: PostgreSQL (Supabase)
-   **ORM**: Drizzle ORM
-   **Frontend Libraries**: React, Vite, Tailwind CSS, Shadcn UI, react-katex, DOMPurify, wouter
-   **Backend Libraries**: Node.js, Express, multer, pdf-parse, drizzle-orm
-   **Testing**: Vitest