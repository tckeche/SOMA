ALTER TABLE "soma_quizzes" ADD COLUMN IF NOT EXISTS "format" text DEFAULT 'mcq' NOT NULL;
