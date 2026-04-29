CREATE TABLE "revision_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"exam_body" text NOT NULL,
	"syllabus_code" text NOT NULL,
	"level" text NOT NULL,
	"exam_date" timestamp,
	"week_hours" integer DEFAULT 6 NOT NULL,
	"weeks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"weak_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"last_report_id" integer,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revision_plans" ADD CONSTRAINT "revision_plans_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_plans" ADD CONSTRAINT "revision_plans_last_report_id_soma_reports_id_fk" FOREIGN KEY ("last_report_id") REFERENCES "public"."soma_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_plans_unique_idx" ON "revision_plans" USING btree ("student_id","subject","syllabus_code","level");