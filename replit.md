# SOMA — Intelligent Assessment Platform

## Overview
SOMA is a full-stack intelligent assessment platform for examined school-level
mathematics and science. Students take interactive MCQ quizzes with
LaTeX-rendered mathematics; tutors build quizzes through a catalogue-aware AI
copilot; super-admins oversee users and content. The platform is built around a
structured curriculum catalogue (examining body → level → subject → syllabus →
topic → subtopic → learning requirement) that grounds every AI call in the
syllabus the tutor actually picked. The goal is assessments that are correct,
syllabus-aligned, and auditable end-to-end.

## User Preferences
I want the agent to focus on completing the assigned tasks.
I prefer to use a modern and efficient development workflow.
I appreciate clear and concise communication.
I want the agent to use proper Markdown formatting for all text.

## System Architecture

### UI/UX
React + Vite + Tailwind + Shadcn UI. Math rendering via ReactMarkdown +
remark-math + rehype-katex (through `MarkdownRenderer`). Graphs through the
`GraphPlot` component with unique SVG ids and graceful fallbacks. Glassmorphism
on the auth and tutor surfaces; plaque-first tutor dashboard with flip
animations and subject-specific colour/icon utilities.

### Backend
Node.js + Express + Drizzle ORM on PostgreSQL (Supabase-hosted). Authentication
via Supabase Auth, joined with the `soma_users` table. RBAC roles:
`student`, `tutor`, `super_admin`. Routing on the frontend via wouter.

### Curriculum catalogue (Phases 1–6)
The canonical source of truth for subject/syllabus context is a normalised
catalogue:

  examining_bodies → levels → subjects → syllabi → topics →
  subtopics → learning_requirements → competencies → papers

A Phase 5 tutor builder walks the tutor through this hierarchy; Phase 6 wires
the selection into the AI pipeline as a single `CatalogueCopilotContext`
payload (see `server/services/copilotContext.ts`). `formatCopilotContextAsText`
renders a deterministic prompt block that slots into LLM user messages, not
the system prompt — cached system prompts stay stable.

### Reference-text & semantic retrieval (Phase 7 + 9)
`server/services/topicReferenceText.ts` deterministically builds one text
"chunk" per (topic, tier) pair, hashed for idempotent regeneration.
`server/services/topicEmbeddings.ts` embeds chunks via OpenAI
`text-embedding-3-small` (1536-dim, jsonb-stored — no pgvector at current
scale) and upserts keyed by content hash.
`server/services/semanticTopicSearch.ts` filters candidates by metadata
(body/level/subject/tier) before a cosine rank with a small lexical
keyword-boost tie-breaker.

Phase 9 wires this into `loadCopilotContext`: if the tutor writes a prompt
but doesn't pick topics, the loader runs semantic search and auto-populates
`selectedTopics` with the top-K matches. The context exposes
`autoSelectedFromQuery` so the prompt text explicitly tells the LLM "these
topics were matched from your phrasing". All failure modes (missing
OPENAI_API_KEY, no embeddings populated, API timeout) fall through silently
to the subject-level digest.

A separate `stripSyllabusNoise` pre-processor drops page numbers, running
headers, © UCLES lines, "How to register candidates" admin blocks and other
PDF noise before any AI touches it.

### AI generation pipeline (Phases 2, 8)
`server/services/aiPipeline.ts` runs a multi-stage SOMA pipeline:

  1. **Maker** — GPT-4o via `generateWithFallback`
     (`gpt-4o → claude-sonnet-4-6 → gemini-2.5-flash → o3-mini → deepseek →
     gpt-4o-mini`). Drafts the question set.
  2. **Gemini formatting Checker** — called directly (not via fallback) to
     audit LaTeX, currency symbols, option balance, scope, and emit
     `PipelineWarning`s. Phase 8's `reconcileCheckerStems` guard reverts
     any silent stem rewrites the checker emits without a corresponding
     warning, keeping Maker's wording authoritative.
  3. **Claude Polisher** — runs only when the checker surfaced real issues
     (`checkerOk` flag prevents invocation on availability noise), saving
     roughly half the cost on clean runs.
  4. **Blind Dual-Check** — Gemini + Claude independently verify the final
     set; consensus-only corrections are merged (answer/explanation only, no
     wholesale rewrites).
  5. **Math Validator** — arithmetic, unit, and answer-consistency sweep.

Phase 8 caches the catalogue text once per generation (used to be
re-serialised at five sites) via `context.catalogueContextText`.

### Legacy PDF path (Phase 10)
The older `syllabus_documents` + `syllabus_chunks` tables and the
`scripts/ingestCurriculumDocs.ts` script are retained as a back-compat
bridge for syllabi not yet in the structured catalogue. The copilot-chat
route prefers catalogue context; PDF chunks are attached only as optional
supporting text. These tables will be removed once catalogue coverage is
full.

### Tutor builder & copilot
- `Tutor Portal` — Command Centre dashboard (KPIs, intervention queues,
  subject performance, student management, diagnostic workspaces,
  academic summaries).
- `AI Copilot (Builder)` — catalogue-driven wizard (body → level →
  subject → syllabus → optional topic pick). Returns typed drafts into an
  in-memory draft layer; questions only hit `soma_questions` on explicit
  Save & Publish.
- `AI Dashboard Intelligence` — narratives, weakness lists, and
  at-risk flags synthesised from assessment data.

### Student experience
- `Soma Quiz Engine` — LaTeX-aware MCQ player with summary view.
- `Soma Quiz Review` — post-quiz review with explanations,
  correct/incorrect markers, and AI feedback.

### Auth system
Single `/login` route with tab-based login / signup / forgot-password.
Inline error handling for auth failures.

## Development ledger

Incremental phases since the catalogue migration started:

| Phase | Focus |
|------|-------|
| 1    | Catalogue schema + seed for Cambridge. |
| 2    | SOMA pipeline skeleton + generateWithFallback. |
| 3    | Normalised topics/subtopics/requirements/competencies. |
| 4    | `syllabusCatalogue.ts` service + read endpoints. |
| 5    | Tutor builder rewritten as catalogue wizard. |
| 6    | Catalogue context injected into copilot + SOMA pipeline. |
| 7    | Reference-text layer, topic embeddings, semantic search, noise stripper, `scripts/embedTopics.ts`. |
| 8    | Correctness baseline: catalogue-text cache, Maker stem-drift guard, Maker fallback documentation corrected. |
| 9    | Semantic auto-select wired into `loadCopilotContext` + `/api/tutor/copilot-chat`, `/api/soma/generate`, `/api/tutor/quizzes/generate`. |
| 10   | Curriculum unification: catalogue is primary source; `syllabus_documents` explicitly deprecated; `ingestCurriculumDocs.ts` marked legacy. |
| 11   | Docs + pipeline ledger (this file). |

## External Dependencies
- **Auth**: Supabase Auth
- **AI/LLM Providers**:
    - Google Generative AI (Gemini)
    - Anthropic AI SDK (Claude)
    - OpenAI (GPT-4o, GPT-4o-mini, `text-embedding-3-small`)
    - DeepSeek
- **Database**: PostgreSQL (Supabase)
- **ORM**: Drizzle ORM
- **Frontend Libraries**: React, Vite, Tailwind CSS, Shadcn UI,
  react-katex, DOMPurify, wouter
- **Backend Libraries**: Node.js, Express, multer, pdf-parse, drizzle-orm
- **Testing**: Vitest with inline snapshots; pure-function design keeps
  DB + network out of unit tests.
