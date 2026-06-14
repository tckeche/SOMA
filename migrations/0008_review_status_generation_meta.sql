ALTER TABLE "soma_questions" ADD COLUMN "review_status" text NOT NULL DEFAULT 'approved';--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN "generation_meta" jsonb;
