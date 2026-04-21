CREATE TABLE IF NOT EXISTS "assessment_objective_competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"assessment_objective_id" integer NOT NULL,
	"competency_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assessment_objectives" (
	"id" serial PRIMARY KEY NOT NULL,
	"syllabus_id" integer NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"weighting_pct" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "examiner_misconceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"board" text NOT NULL,
	"syllabus_code" text NOT NULL,
	"subject" text,
	"topic" text NOT NULL,
	"subtopic" text,
	"misconception" text NOT NULL,
	"student_error" text NOT NULL,
	"correct_approach" text NOT NULL,
	"frequency" text DEFAULT 'common' NOT NULL,
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "examining_bodies" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flagged_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"question_id" integer NOT NULL,
	"quiz_id" integer NOT NULL,
	"report_id" integer,
	"reason" text,
	"resolved_at" timestamp,
	"tutor_viewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_requirement_competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"learning_requirement_id" integer NOT NULL,
	"competency_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"subtopic_id" integer NOT NULL,
	"statement" text NOT NULL,
	"command_word" text,
	"notes_and_examples" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"top_band" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_topic_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"paper_id" integer NOT NULL,
	"topic_id" integer NOT NULL,
	"weight" text DEFAULT 'covered' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "papers" (
	"id" serial PRIMARY KEY NOT NULL,
	"syllabus_id" integer NOT NULL,
	"paper_number" integer NOT NULL,
	"code" text,
	"title" text NOT NULL,
	"level_tier" text NOT NULL,
	"core_or_extended" text,
	"duration_minutes" integer,
	"raw_marks" integer,
	"style" text,
	"weighting_pct" jsonb,
	"assumes_prior_content_from_paper_numbers" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_reset_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quiz_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"student_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "soma_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"stem" text NOT NULL,
	"options" json NOT NULL,
	"correct_answer" text NOT NULL,
	"explanation" text NOT NULL,
	"marks" integer DEFAULT 1 NOT NULL,
	"question_type" text DEFAULT 'multiple_choice' NOT NULL,
	"graph_spec" jsonb,
	"topic_tag" text,
	"subtopic_tag" text,
	"difficulty_tag" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "soma_quizzes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"topic" text NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"syllabus" text DEFAULT 'IEB',
	"level" text DEFAULT 'Grade 6-12',
	"subject" text,
	"curriculum_context" text,
	"author_id" uuid,
	"time_limit_minutes" integer DEFAULT 60 NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "soma_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"quiz_id" integer NOT NULL,
	"student_id" uuid,
	"student_name" text NOT NULL,
	"score" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"ai_feedback_html" text,
	"answers_json" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "soma_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"role" text DEFAULT 'student' NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "student_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "student_subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"exam_body" text NOT NULL,
	"syllabus_code" text NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "student_topic_mastery" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"topic" text NOT NULL,
	"subtopic" text,
	"understanding_percent" integer DEFAULT 0 NOT NULL,
	"mastery_achieved" boolean DEFAULT false NOT NULL,
	"covered" boolean DEFAULT false NOT NULL,
	"tested" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"total_questions" integer DEFAULT 0 NOT NULL,
	"correct_questions" integer DEFAULT 0 NOT NULL,
	"confidence_level" text DEFAULT 'low' NOT NULL,
	"last_tested_at" timestamp,
	"next_review_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"examining_body_id" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtopic_competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"subtopic_id" integer NOT NULL,
	"competency_id" integer NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtopic_paper_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"subtopic_id" integer NOT NULL,
	"paper_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subtopics" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"subtopic_number" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"level_tier" text NOT NULL,
	"core_or_extended" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suggested_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"tutor_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"purpose" text NOT NULL,
	"rationale" text NOT NULL,
	"topic" text NOT NULL,
	"subtopic" text,
	"target_difficulty" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"generated_quiz_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syllabi" (
	"id" serial PRIMARY KEY NOT NULL,
	"examining_body_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"top_band" text NOT NULL,
	"syllabus_code" text NOT NULL,
	"title" text NOT NULL,
	"years_valid_from" integer,
	"years_valid_to" integer,
	"source_file" text,
	"content_hash" text,
	"successor_syllabus_code" text,
	"command_word_glossary" jsonb,
	"notes" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syllabus_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_preview" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syllabus_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"tutor_id" uuid,
	"board" text NOT NULL,
	"level" text NOT NULL,
	"syllabus_code" text NOT NULL,
	"filename" text NOT NULL,
	"extracted_text" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"document_type" text DEFAULT 'syllabus' NOT NULL,
	"subject" text,
	"original_path" text,
	"content_hash" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syllabus_strands" (
	"id" serial PRIMARY KEY NOT NULL,
	"syllabus_id" integer NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "syllabus_topic_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"board" text NOT NULL,
	"syllabus_code" text NOT NULL,
	"subject" text,
	"topic" text NOT NULL,
	"subtopic" text,
	"description" text,
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"competency_id" integer NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"level_tier" text NOT NULL,
	"chunk_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" jsonb NOT NULL,
	"embedded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"syllabus_id" integer NOT NULL,
	"strand_id" integer,
	"topic_number" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"level_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prerequisite_topic_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tutor_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"tutor_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"comment" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tutor_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"tutor_id" uuid NOT NULL,
	"student_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tutor_students" (
	"id" serial PRIMARY KEY NOT NULL,
	"tutor_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE IF EXISTS "assessment_objective_competencies" ADD CONSTRAINT "assessment_objective_competencies_assessment_objective_id_assessment_objectives_id_fk" FOREIGN KEY ("assessment_objective_id") REFERENCES "public"."assessment_objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "assessment_objective_competencies" ADD CONSTRAINT "assessment_objective_competencies_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "assessment_objectives" ADD CONSTRAINT "assessment_objectives_syllabus_id_syllabi_id_fk" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "examiner_misconceptions" ADD CONSTRAINT "examiner_misconceptions_document_id_syllabus_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."syllabus_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "flagged_questions" ADD CONSTRAINT "flagged_questions_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "flagged_questions" ADD CONSTRAINT "flagged_questions_question_id_soma_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."soma_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "flagged_questions" ADD CONSTRAINT "flagged_questions_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."soma_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "flagged_questions" ADD CONSTRAINT "flagged_questions_report_id_soma_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."soma_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "learning_requirement_competencies" ADD CONSTRAINT "learning_requirement_competencies_learning_requirement_id_learning_requirements_id_fk" FOREIGN KEY ("learning_requirement_id") REFERENCES "public"."learning_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "learning_requirement_competencies" ADD CONSTRAINT "learning_requirement_competencies_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "learning_requirements" ADD CONSTRAINT "learning_requirements_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "paper_topic_mappings" ADD CONSTRAINT "paper_topic_mappings_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "paper_topic_mappings" ADD CONSTRAINT "paper_topic_mappings_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "papers" ADD CONSTRAINT "papers_syllabus_id_syllabi_id_fk" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "quiz_assignments" ADD CONSTRAINT "quiz_assignments_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."soma_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "quiz_assignments" ADD CONSTRAINT "quiz_assignments_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "soma_questions" ADD CONSTRAINT "soma_questions_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."soma_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "soma_quizzes" ADD CONSTRAINT "soma_quizzes_author_id_soma_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."soma_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "soma_reports" ADD CONSTRAINT "soma_reports_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."soma_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "soma_reports" ADD CONSTRAINT "soma_reports_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "student_notifications" ADD CONSTRAINT "student_notifications_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "student_subjects" ADD CONSTRAINT "student_subjects_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "student_topic_mastery" ADD CONSTRAINT "student_topic_mastery_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "subjects" ADD CONSTRAINT "subjects_examining_body_id_examining_bodies_id_fk" FOREIGN KEY ("examining_body_id") REFERENCES "public"."examining_bodies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "subtopic_competencies" ADD CONSTRAINT "subtopic_competencies_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "subtopic_competencies" ADD CONSTRAINT "subtopic_competencies_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "subtopic_paper_mappings" ADD CONSTRAINT "subtopic_paper_mappings_subtopic_id_subtopics_id_fk" FOREIGN KEY ("subtopic_id") REFERENCES "public"."subtopics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "subtopic_paper_mappings" ADD CONSTRAINT "subtopic_paper_mappings_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "subtopics" ADD CONSTRAINT "subtopics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "suggested_assessments" ADD CONSTRAINT "suggested_assessments_tutor_id_soma_users_id_fk" FOREIGN KEY ("tutor_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "suggested_assessments" ADD CONSTRAINT "suggested_assessments_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "suggested_assessments" ADD CONSTRAINT "suggested_assessments_generated_quiz_id_soma_quizzes_id_fk" FOREIGN KEY ("generated_quiz_id") REFERENCES "public"."soma_quizzes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "syllabi" ADD CONSTRAINT "syllabi_examining_body_id_examining_bodies_id_fk" FOREIGN KEY ("examining_body_id") REFERENCES "public"."examining_bodies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "syllabi" ADD CONSTRAINT "syllabi_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "syllabus_chunks" ADD CONSTRAINT "syllabus_chunks_document_id_syllabus_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."syllabus_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "syllabus_documents" ADD CONSTRAINT "syllabus_documents_tutor_id_soma_users_id_fk" FOREIGN KEY ("tutor_id") REFERENCES "public"."soma_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "syllabus_strands" ADD CONSTRAINT "syllabus_strands_syllabus_id_syllabi_id_fk" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "syllabus_topic_inventory" ADD CONSTRAINT "syllabus_topic_inventory_document_id_syllabus_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."syllabus_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "topic_competencies" ADD CONSTRAINT "topic_competencies_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "topic_competencies" ADD CONSTRAINT "topic_competencies_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "topic_embeddings" ADD CONSTRAINT "topic_embeddings_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "topics" ADD CONSTRAINT "topics_syllabus_id_syllabi_id_fk" FOREIGN KEY ("syllabus_id") REFERENCES "public"."syllabi"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "topics" ADD CONSTRAINT "topics_strand_id_syllabus_strands_id_fk" FOREIGN KEY ("strand_id") REFERENCES "public"."syllabus_strands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "tutor_comments" ADD CONSTRAINT "tutor_comments_tutor_id_soma_users_id_fk" FOREIGN KEY ("tutor_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "tutor_comments" ADD CONSTRAINT "tutor_comments_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "tutor_notifications" ADD CONSTRAINT "tutor_notifications_tutor_id_soma_users_id_fk" FOREIGN KEY ("tutor_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "tutor_notifications" ADD CONSTRAINT "tutor_notifications_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "tutor_students" ADD CONSTRAINT "tutor_students_tutor_id_soma_users_id_fk" FOREIGN KEY ("tutor_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE IF EXISTS "tutor_students" ADD CONSTRAINT "tutor_students_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ao_comp_unique_idx" ON "assessment_objective_competencies" USING btree ("assessment_objective_id","competency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_objectives_syllabus_code_idx" ON "assessment_objectives" USING btree ("syllabus_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "competencies_code_idx" ON "competencies" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "examining_bodies_slug_idx" ON "examining_bodies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "flagged_question_unique_idx" ON "flagged_questions" USING btree ("student_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lr_comp_unique_idx" ON "learning_requirement_competencies" USING btree ("learning_requirement_id","competency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "levels_code_idx" ON "levels" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_topic_unique_idx" ON "paper_topic_mappings" USING btree ("paper_id","topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "papers_syllabus_number_idx" ON "papers" USING btree ("syllabus_id","paper_number");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_assignment_unique_idx" ON "quiz_assignments" USING btree ("quiz_id","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_topic_mastery_unique_idx" ON "student_topic_mastery" USING btree ("student_id","subject","topic","subtopic");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_body_slug_idx" ON "subjects" USING btree ("examining_body_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "subtopic_comp_unique_idx" ON "subtopic_competencies" USING btree ("subtopic_id","competency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subtopic_paper_unique_idx" ON "subtopic_paper_mappings" USING btree ("subtopic_id","paper_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subtopics_topic_number_idx" ON "subtopics" USING btree ("topic_id","subtopic_number");--> statement-breakpoint
CREATE UNIQUE INDEX "syllabi_body_code_idx" ON "syllabi" USING btree ("examining_body_id","syllabus_code");--> statement-breakpoint
CREATE UNIQUE INDEX "syllabus_strands_syllabus_name_idx" ON "syllabus_strands" USING btree ("syllabus_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_comp_unique_idx" ON "topic_competencies" USING btree ("topic_id","competency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_embeddings_topic_tier_idx" ON "topic_embeddings" USING btree ("topic_id","level_tier");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_syllabus_number_idx" ON "topics" USING btree ("syllabus_id","topic_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_student_unique_idx" ON "tutor_students" USING btree ("tutor_id","student_id");