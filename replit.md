# SOMA — Intelligent Assessment Platform

## Overview
A full-stack educational assessment platform (SOMA). Students take interactive MCQ quizzes with LaTeX-rendered math notation. Tutors manage students, create assessments via AI copilot, and view analytics. Super admins have global management. All legacy V1/V2 quiz infrastructure has been purged — the platform runs exclusively on the Soma pipeline.

## Tech Stack
- **Frontend:** React (Vite), Tailwind CSS, Shadcn UI, react-katex for LaTeX rendering, DOMPurify for XSS protection, @supabase/supabase-js for auth
- **Backend:** Node.js, Express, @google/generative-ai (Gemini), @anthropic-ai/sdk (Claude), openai (GPT-4o & DeepSeek), multer for file uploads
- **Database:** PostgreSQL with Drizzle ORM (auto-failover: tries SUPABASE_URL → SUPABASE_DB_URL → DATABASE_URL)
- **Auth:** Supabase Auth (client initialized in `client/src/lib/supabase.ts` using VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)
- **Routing:** wouter

## Project Architecture

### Database Schema (Soma-only — legacy tables removed)
- `soma_users` - id (uuid, maps to Supabase auth UID), email, display_name, role, created_at
- `soma_quizzes` - id, title, topic, syllabus, level, subject, curriculum_context, author_id, time_limit_minutes (default 60), status (always "published"), is_archived, created_at
- `soma_questions` - id, quiz_id (FK → soma_quizzes), stem, options (JSON), correct_answer, explanation (NOT NULL), marks
- `soma_reports` - id, quiz_id (FK → soma_quizzes), student_id (uuid FK → soma_users), student_name, score, status, ai_feedback_html, answers_json, started_at, completed_at, created_at
- `tutor_students` - id, tutor_id, student_id (unique index), created_at
- `quiz_assignments` - id, quiz_id, student_id, status, due_date (optional timestamp), created_at
- `tutor_comments` - id, tutor_id, student_id, comment, created_at
- `password_reset_requests` - id, email, created_at (audit log for password reset attempts)

### Key Files
- `shared/schema.ts` - Drizzle schema definitions and Zod validation schemas (soma tables only)
- `server/db.ts` - Database connection with auto-failover (tries Supabase PostgreSQL first, falls back to Replit Helium DB)
- `server/storage.ts` - Storage layer (DatabaseStorage + MemoryStorage implementing IStorage)
- `server/routes.ts` - All API routes including AI endpoints
- `server/seed.ts` - Database seeding with sample soma quizzes
- `client/src/pages/builder.tsx` - Quiz builder: AI copilot creates soma quizzes. Mobile-first responsive layout. Copilot auto-creates quiz and saves questions to soma_questions. Supports create (`/admin/builder`) and edit (`/admin/builder/:id`) modes. Dual-auth: accepts legacy admin cookie OR Supabase JWT (tutor/super_admin). Sends `Authorization: Bearer <supabase_access_token>` header when using Supabase auth.
- `client/src/lib/subjectColors.ts` - Shared subject color & icon utility.
- `client/src/pages/StudentDashboard.tsx` - Student dashboard: available quizzes via auth-gated `/api/quizzes/available`, completed items (soma reports only), subject donut charts, AI analysis.
- `client/src/pages/StudentAuth.tsx` - Student login/signup with Supabase Auth (glassmorphism UI)
- `client/src/components/ProtectedRoute.tsx` - Auth-gated route wrapper
- `client/src/pages/TutorDashboard.tsx` - Tutor analytics dashboard with cohort donut charts, stat cards, recent submissions feed
- `client/src/pages/TutorStudents.tsx` - Tutor student roster with adopt/remove, search
- `client/src/pages/TutorStudentDetail.tsx` - Student drill-down: assessment history, private tutor notes
- `client/src/pages/TutorAssessments.tsx` - Tutor assessment management with assign-to-students modal
- `client/src/pages/SuperAdminDashboard.tsx` - Super admin global management. Route: `/super-admin`
- `client/src/pages/soma-quiz.tsx` - Student quiz engine
- `client/src/pages/SomaQuizReview.tsx` - Post-quiz review with explanations
- `client/src/pages/ForgotPassword.tsx` - Standalone forgot-password page: email form → POST /api/auth/forgot-password → Supabase sends recovery email
- `client/src/pages/ResetPassword.tsx` - Reset-password landing page: handles Supabase PKCE & implicit recovery tokens, validates new+confirm password match, calls supabase.auth.updateUser

### API Endpoints
- `POST /api/auth/forgot-password` - Rate-limited (5/15min). Validates email, logs to password_reset_requests, triggers Supabase recovery email. Always returns 200 to prevent user enumeration.
- `POST /api/auth/sync` - Upsert Supabase user into soma_users table
- `GET /api/auth/me` - Get current user (auto-creates soma_users record if missing)
- `GET /api/quizzes/available` - Auth-gated: quizzes assigned to this student
- `GET /api/student/reports` - Get student's soma reports with quiz data
- `GET /api/student/submissions` - Returns empty array (legacy removed)
- `POST /api/soma/quizzes/:id/submit` - Submit soma quiz answers
- `GET /api/soma/quizzes/:id/check-submission` - Check if student already submitted
- `GET /api/soma/reports/:reportId/review` - Get report + questions with correct answers for review
- `POST /api/soma/reports/:reportId/retry` - Retry failed AI grading
- `POST /api/soma/global-tutor` - Global AI Tutor endpoint
- `GET /api/admin/quizzes` - List all soma quizzes (admin, proxied to soma_quizzes)
- `GET /api/admin/quizzes/:id` - Get soma quiz with questions
- `POST /api/admin/quizzes` - Create soma quiz
- `PUT /api/admin/quizzes/:id` - Update soma quiz metadata
- `DELETE /api/admin/quizzes/:id` - Delete soma quiz
- `GET /api/admin/quizzes/:id/questions` - Get soma questions
- `POST /api/admin/quizzes/:id/questions` - Add questions to soma quiz
- `DELETE /api/admin/questions/:id` - Delete soma question
- `POST /api/admin/copilot-chat` - AI copilot chat for quiz generation
- `POST /api/upload-image` - Upload image for question attachment
- `GET /api/tutor/*` - Tutor endpoints (students, performance, dashboard-stats, comments, quizzes/:quizId/reports)
- `GET /api/super-admin/*` - Super admin endpoints (users, quizzes, delete)

### Key Features
- **RBAC (Role-Based Access Control)**: Three roles — `student`, `tutor`, `super_admin`. Automated domain-based assignment on auth sync.
- **Soma Quiz Engine**: Student-facing quiz UI with glassmorphism cards, LaTeX rendering, option selection, navigation dots, summary view.
- **Soma Quiz Review**: Post-quiz review with explanations, correct/incorrect indicators, AI feedback.
- **Admin Route Deprecation**: `/admin` redirects to `/login`. Builder (`/admin/builder`) remains accessible.
- **AI Copilot**: Builder page uses copilot chat to generate quiz questions via AI fallback chain.
- **AI Orchestrator**: Centralized dynamic fallback chain (`server/services/aiOrchestrator.ts`). Model order: Claude claude-sonnet-4-6 → Gemini 2.0 Flash → DeepSeek → GPT-4o. Maker-Checker pipeline in `server/services/aiPipeline.ts`.
- **Tutor Portal**: Multi-page navigation (Dashboard, Students, Assessments) with analytics, student management, comments.
- **Super Admin Dashboard**: Global management with user/quiz data tables, hard delete.
- **Legacy V1/V2 Purge Complete**: All legacy `quizzes`, `questions`, `students`, `submissions` tables, routes, storage methods, and frontend pages (`quiz.tsx`, `home.tsx`, `admin.tsx`, `analytics.tsx`) have been removed. The builder now creates soma quizzes directly.
