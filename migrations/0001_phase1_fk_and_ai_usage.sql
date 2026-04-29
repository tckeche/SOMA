CREATE TABLE "ai_usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" text,
	"parent_request_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"task_type" text,
	"prompt_version" text,
	"route" text,
	"user_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"validation_failed" boolean DEFAULT false NOT NULL,
	"parse_failed" boolean DEFAULT false NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "subtopic_id" integer;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "learning_requirement_id" integer;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "reviewed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "review_notes" text;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "source_quote" text;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "source_page" integer;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD COLUMN "confidence_pct" integer;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN "subtopic_id" integer;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN "learning_requirement_id" integer;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN "target_misconception_ids" jsonb;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN "command_word" text;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD COLUMN "assessment_objective" text;--> statement-breakpoint
ALTER TABLE "student_topic_mastery" ADD COLUMN "subtopic_id" integer;--> statement-breakpoint
ALTER TABLE "student_topic_mastery" ADD COLUMN "learning_requirement_id" integer;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD CONSTRAINT "examiner_misconceptions_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD CONSTRAINT "examiner_misconceptions_learning_requirement_id_learning_requirements_id_fk" FOREIGN KEY ("learning_requirement_id") REFERENCES "public"."learning_requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examiner_misconceptions" ADD CONSTRAINT "examiner_misconceptions_reviewed_by_id_soma_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."soma_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD CONSTRAINT "soma_questions_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soma_questions" ADD CONSTRAINT "soma_questions_learning_requirement_id_learning_requirements_id_fk" FOREIGN KEY ("learning_requirement_id") REFERENCES "public"."learning_requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_topic_mastery" ADD CONSTRAINT "student_topic_mastery_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_topic_mastery" ADD CONSTRAINT "student_topic_mastery_learning_requirement_id_learning_requirements_id_fk" FOREIGN KEY ("learning_requirement_id") REFERENCES "public"."learning_requirements"("id") ON DELETE set null ON UPDATE no action;