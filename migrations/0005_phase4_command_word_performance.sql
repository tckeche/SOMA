CREATE TABLE "command_word_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"command_word" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"marks_attempted" integer DEFAULT 0 NOT NULL,
	"marks_awarded" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "command_word_performance" ADD CONSTRAINT "command_word_performance_student_id_soma_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."soma_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "command_word_performance_unique_idx" ON "command_word_performance" USING btree ("student_id","subject","command_word");