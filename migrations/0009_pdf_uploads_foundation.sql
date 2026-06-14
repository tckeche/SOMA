CREATE TABLE IF NOT EXISTS "assessment_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "submission_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"student_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"score" integer,
	"max_score" integer,
	"feedback" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"marked_at" timestamptz
);
--> statement-breakpoint
ALTER TABLE "assessment_attachments" ADD CONSTRAINT "assessment_attachments_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "soma_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attachments" ADD CONSTRAINT "assessment_attachments_uploaded_by_soma_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "soma_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_uploads" ADD CONSTRAINT "submission_uploads_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "soma_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_uploads" ADD CONSTRAINT "submission_uploads_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "submission_upload_quiz_student_idx" ON "submission_uploads" ("quiz_id","student_id");
