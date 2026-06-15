-- Performance indexes on hot foreign-key columns.
-- These FK columns were unindexed, forcing sequential scans on the highest-
-- traffic read paths (student/tutor dashboards, quiz reads, notifications).
-- All use IF NOT EXISTS so the migration is idempotent under drizzle-kit push.
CREATE INDEX IF NOT EXISTS "soma_questions_quiz_id_idx" ON "soma_questions" ("quiz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "soma_reports_student_id_idx" ON "soma_reports" ("student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "soma_reports_quiz_id_idx" ON "soma_reports" ("quiz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quiz_assignments_student_id_idx" ON "quiz_assignments" ("student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "student_notifications_student_id_created_at_idx" ON "student_notifications" ("student_id", "created_at");
