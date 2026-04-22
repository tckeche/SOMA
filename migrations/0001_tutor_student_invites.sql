-- Pending tutor→student invites. A tutor enters an email; we store it here
-- so they can track / resend / cancel, and auto-adopt the student on signup.
-- Project uses `drizzle-kit push` so this file is a reference snapshot; run
-- `npm run db:push` after pulling to have the schema synced in place.
CREATE TABLE IF NOT EXISTS "tutor_student_invites" (
  "id" serial PRIMARY KEY NOT NULL,
  "tutor_id" uuid NOT NULL,
  "email" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "last_sent_at" timestamp DEFAULT now() NOT NULL,
  "accepted_at" timestamp,
  "accepted_by_student_id" uuid
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tutor_student_invites" ADD CONSTRAINT "tutor_student_invites_tutor_id_soma_users_id_fk"
    FOREIGN KEY ("tutor_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tutor_student_invites" ADD CONSTRAINT "tutor_student_invites_accepted_by_student_id_soma_users_id_fk"
    FOREIGN KEY ("accepted_by_student_id") REFERENCES "public"."soma_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tutor_student_invite_unique_idx" ON "tutor_student_invites" USING btree ("tutor_id", "email");
