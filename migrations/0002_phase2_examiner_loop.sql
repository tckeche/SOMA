CREATE TABLE "answer_diagnoses" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"question_id" integer NOT NULL,
	"student_id" uuid NOT NULL,
	"chosen_option_index" integer,
	"chosen_option_text" text,
	"correct" boolean NOT NULL,
	"misconception_id" integer,
	"diagnosis_category" text,
	"rationale" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_misconceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"misconception_id" integer NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"consecutive_correct" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"last_report_id" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_diagnoses" ADD CONSTRAINT "answer_diagnoses_report_id_soma_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."soma_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_diagnoses" ADD CONSTRAINT "answer_diagnoses_question_id_soma_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."soma_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_diagnoses" ADD CONSTRAINT "answer_diagnoses_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_diagnoses" ADD CONSTRAINT "answer_diagnoses_misconception_id_examiner_misconceptions_id_fk" FOREIGN KEY ("misconception_id") REFERENCES "public"."examiner_misconceptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_misconceptions" ADD CONSTRAINT "student_misconceptions_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_misconceptions" ADD CONSTRAINT "student_misconceptions_misconception_id_examiner_misconceptions_id_fk" FOREIGN KEY ("misconception_id") REFERENCES "public"."examiner_misconceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_misconceptions" ADD CONSTRAINT "student_misconceptions_last_report_id_soma_reports_id_fk" FOREIGN KEY ("last_report_id") REFERENCES "public"."soma_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_diagnoses_unique_idx" ON "answer_diagnoses" USING btree ("report_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_misconception_unique_idx" ON "student_misconceptions" USING btree ("student_id","misconception_id");