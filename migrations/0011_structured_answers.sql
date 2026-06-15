-- Structured / written-answer assessments.
-- Quiz-engine assessments gain a sub-type (mcq | structured | hybrid), an
-- authoritative question count, and a structured-question split. Questions
-- gain a mark scheme for AI marking; reports gain per-question structured
-- marking that the tutor confirms before the score is released.
ALTER TABLE "soma_quizzes" ADD COLUMN IF NOT EXISTS "quiz_mode" text DEFAULT 'mcq' NOT NULL;--> statement-breakpoint
ALTER TABLE "soma_quizzes" ADD COLUMN IF NOT EXISTS "question_count" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "soma_quizzes" ADD COLUMN IF NOT EXISTS "structured_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN IF NOT EXISTS "mark_scheme" text;--> statement-breakpoint
ALTER TABLE "soma_reports" ADD COLUMN IF NOT EXISTS "structured_marking" jsonb;
