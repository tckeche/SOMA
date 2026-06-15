-- Student-requested review of AI structured marking.
-- The AI marks structured answers and releases the score automatically; a
-- student who disagrees can request a tutor review, tracked by these columns.
ALTER TABLE "soma_reports" ADD COLUMN IF NOT EXISTS "review_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "soma_reports" ADD COLUMN IF NOT EXISTS "review_request_note" text;--> statement-breakpoint
ALTER TABLE "soma_reports" ADD COLUMN IF NOT EXISTS "review_requested_at" timestamp;
