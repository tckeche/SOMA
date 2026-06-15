/**
 * Single runtime authority for the production database schema.
 *
 * Every column/table declared in `shared/schema.ts` MUST also have a
 * matching idempotent `CREATE` / `ALTER ... ADD COLUMN IF NOT EXISTS`
 * statement in `BOOTSTRAP_QUERIES` below. The list is replayed on every
 * server start so a fresh database (or one missing a recent column)
 * converges to the schema the application code expects.
 *
 * NOTE: the `migrations/*.sql` folder is **not** run on startup. It exists
 * solely as the fixture replayed by the PGlite test harness
 * (`tests/helpers/pglite.ts`); see `migrations/README.md`. Production
 * never executes those files.
 *
 * After applying the queries we run `verifySchemaMatchesDb()` — if the
 * live DB is still missing anything `shared/schema.ts` declares, we fail
 * loudly. In production that means the server refuses to start (better
 * than 500ing on the first SELECT that hits the missing column, as
 * happened with `option_rationales does not exist`). In development we
 * warn but continue so a working dev DB isn't blocked by an in-progress
 * schema change.
 *
 * ## Adding a new column / table
 * 1. Add the field to `shared/schema.ts`.
 * 2. Add a matching idempotent statement to `BOOTSTRAP_QUERIES` below
 *    (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`,
 *    `CREATE TABLE IF NOT EXISTS ...`, etc.).
 * 3. If the change is also needed for service-level integration tests
 *    that use the PGlite harness, add a corresponding `migrations/NNNN_*.sql`
 *    file and add it to `migrations/meta/_journal.json`.
 *
 * Forgetting step 2 is exactly what the verifier catches: server startup
 * will fail with a "missing column: <table>.<column>" error pointing
 * straight at the field you forgot.
 */
import { pool } from "./db";
import { log } from "./utils/logging";
import {
  formatDriftReport,
  hasDrift,
  verifySchemaMatchesDb,
} from "./schemaVerifier";

const BOOTSTRAP_QUERIES = [
  `ALTER TABLE soma_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student'`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES soma_users(id) ON DELETE SET NULL`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS time_limit_minutes INTEGER NOT NULL DEFAULT 60`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'mcq'`,
  `CREATE TABLE IF NOT EXISTS tutor_students (id SERIAL PRIMARY KEY, tutor_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tutor_student_unique_idx ON tutor_students(tutor_id, student_id)`,
  `CREATE TABLE IF NOT EXISTS quiz_assignments (id SERIAL PRIMARY KEY, quiz_id INTEGER NOT NULL REFERENCES soma_quizzes(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS quiz_assignment_unique_idx ON quiz_assignments(quiz_id, student_id)`,
  `CREATE TABLE IF NOT EXISTS tutor_comments (id SERIAL PRIMARY KEY, tutor_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, comment TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `ALTER TABLE quiz_assignments ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ`,
  `ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`,
  `ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`,
  `UPDATE soma_reports SET student_name = su.display_name FROM soma_users su WHERE soma_reports.student_id = su.id AND su.display_name IS NOT NULL AND su.display_name != '' AND soma_reports.student_name != su.display_name AND su.display_name NOT LIKE '%@%'`,
  `CREATE TABLE IF NOT EXISTS password_reset_requests (id SERIAL PRIMARY KEY, email TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS question_type TEXT NOT NULL DEFAULT 'multiple_choice'`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS graph_spec JSONB`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS topic_tag TEXT`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS subtopic_tag TEXT`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS difficulty_tag TEXT`,
  // Phase 1+: FK columns + per-question metadata that the schema expects.
  // These were previously only in migrations/*.sql files but the bootstrap
  // doesn't run those — so production was missing these columns and SELECTs
  // against soma_questions were 500ing in deploy. All additive + nullable.
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS subtopic_id INTEGER`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS learning_requirement_id INTEGER`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS target_misconception_ids JSONB`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS command_word TEXT`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS assessment_objective TEXT`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS option_rationales JSONB`,
  // Phase 5 review gate + generation audit trail. Declared in schema.ts but
  // historically missing from bootstrap, so SELECTs joining soma_questions
  // (e.g. /api/tutor/flagged-questions) 500ed on a fresh/drifted DB.
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS generation_meta JSONB`,
  // Per-student question flagging (tutor review queue). Defined in schema.ts
  // but historically missing from bootstrap, so a fresh DB never got the
  // table and `/api/tutor/flagged-questions` 500ed.
  `CREATE TABLE IF NOT EXISTS flagged_questions (id SERIAL PRIMARY KEY, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, question_id INTEGER NOT NULL REFERENCES soma_questions(id) ON DELETE CASCADE, quiz_id INTEGER NOT NULL REFERENCES soma_quizzes(id) ON DELETE CASCADE, report_id INTEGER REFERENCES soma_reports(id) ON DELETE SET NULL, reason TEXT, resolved_at TIMESTAMP, tutor_viewed_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW() NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS flagged_question_unique_idx ON flagged_questions(student_id, question_id)`,
  `CREATE TABLE IF NOT EXISTS syllabus_documents (id SERIAL PRIMARY KEY, tutor_id UUID REFERENCES soma_users(id) ON DELETE SET NULL, board TEXT NOT NULL, level TEXT NOT NULL, syllabus_code TEXT NOT NULL, filename TEXT NOT NULL, extracted_text TEXT NOT NULL, uploaded_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS syllabus_chunks (id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES syllabus_documents(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, content_preview TEXT NOT NULL)`,
  // Syllabus document extended columns (curriculum ingestion system)
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'syllabus'`,
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS subject TEXT`,
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS original_path TEXT`,
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  // Unique index on soma_reports to prevent duplicate submissions at DB level
  `CREATE UNIQUE INDEX IF NOT EXISTS soma_reports_quiz_student_idx ON soma_reports(quiz_id, student_id) WHERE student_id IS NOT NULL`,
  // Track when a user last logged in (added after initial schema)
  `ALTER TABLE soma_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS student_subjects (id SERIAL PRIMARY KEY, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, subject TEXT NOT NULL, exam_body TEXT NOT NULL, syllabus_code TEXT NOT NULL, level TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS student_topic_mastery (id SERIAL PRIMARY KEY, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, subject TEXT NOT NULL, topic TEXT NOT NULL, subtopic TEXT, understanding_percent INTEGER NOT NULL DEFAULT 0, mastery_achieved BOOLEAN NOT NULL DEFAULT false, covered BOOLEAN NOT NULL DEFAULT false, tested BOOLEAN NOT NULL DEFAULT false, attempts INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS student_topic_mastery_unique_idx ON student_topic_mastery(student_id, subject, topic, subtopic)`,
  `CREATE TABLE IF NOT EXISTS tutor_notifications (id SERIAL PRIMARY KEY, tutor_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, student_id UUID REFERENCES soma_users(id) ON DELETE SET NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, payload JSONB, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS suggested_assessments (id SERIAL PRIMARY KEY, tutor_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, subject TEXT NOT NULL, purpose TEXT NOT NULL, rationale TEXT NOT NULL, topic TEXT NOT NULL, subtopic TEXT, target_difficulty TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'suggested', generated_quiz_id INTEGER REFERENCES soma_quizzes(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  // PR #53: new columns on student_topic_mastery for spaced repetition + confidence scoring
  `ALTER TABLE student_topic_mastery ADD COLUMN IF NOT EXISTS total_questions INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE student_topic_mastery ADD COLUMN IF NOT EXISTS correct_questions INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE student_topic_mastery ADD COLUMN IF NOT EXISTS confidence_level TEXT NOT NULL DEFAULT 'low'`,
  `ALTER TABLE student_topic_mastery ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMPTZ`,
  `ALTER TABLE student_topic_mastery ADD COLUMN IF NOT EXISTS next_review_at TIMESTAMPTZ`,
  // PR #53: new tables for examiner misconceptions + syllabus topic inventory (TF-IDF retrieval)
  `CREATE TABLE IF NOT EXISTS examiner_misconceptions (id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES syllabus_documents(id) ON DELETE CASCADE, board TEXT NOT NULL, syllabus_code TEXT NOT NULL, subject TEXT, topic TEXT NOT NULL, subtopic TEXT, misconception TEXT NOT NULL, student_error TEXT NOT NULL, correct_approach TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'common', extracted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS syllabus_topic_inventory (id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES syllabus_documents(id) ON DELETE CASCADE, board TEXT NOT NULL, syllabus_code TEXT NOT NULL, subject TEXT, topic TEXT NOT NULL, subtopic TEXT, description TEXT, extracted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  // Multi-topic selection: a quiz can cover one or more curriculum topics.
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS topics JSONB NOT NULL DEFAULT '[]'::jsonb`,
  // PR #74: indexes powering the student "Tips for your studies" carousel —
  // the read path filters by (board, syllabusCode, subject) and occasionally
  // narrows by topic; the second index is for subject-only sweeps used by
  // tutor analytics; the third helps the ingestion script's existence check.
  `CREATE INDEX IF NOT EXISTS examiner_misconceptions_board_code_topic_idx ON examiner_misconceptions (board, syllabus_code, topic)`,
  `CREATE INDEX IF NOT EXISTS examiner_misconceptions_subject_idx ON examiner_misconceptions (subject)`,
  `CREATE INDEX IF NOT EXISTS syllabus_documents_type_code_idx ON syllabus_documents (document_type, syllabus_code)`,
  // PDF uploads foundation: tutor-attached worksheets + student PDF responses.
  // The binaries live in the private "soma-uploads" Supabase Storage bucket;
  // these tables hold the object key + metadata + (for submissions) marking.
  `CREATE TABLE IF NOT EXISTS assessment_attachments (id SERIAL PRIMARY KEY, quiz_id INTEGER NOT NULL REFERENCES soma_quizzes(id) ON DELETE CASCADE, filename TEXT NOT NULL, storage_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, uploaded_by UUID REFERENCES soma_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS submission_uploads (id SERIAL PRIMARY KEY, quiz_id INTEGER NOT NULL REFERENCES soma_quizzes(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, filename TEXT NOT NULL, storage_path TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, score INTEGER, max_score INTEGER, feedback TEXT, status TEXT NOT NULL DEFAULT 'submitted', created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL, marked_at TIMESTAMPTZ)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS submission_upload_quiz_student_idx ON submission_uploads(quiz_id, student_id)`,
  // Structured / written-answer assessments (migrations 0011 + 0012). These
  // columns were only declared in migrations/*.sql and shared/schema.ts, but
  // the bootstrap — which is what actually runs against the live DB on every
  // start — never got them, so SELECTs touching soma_quizzes/soma_reports
  // (e.g. /api/student/dashboard) 500ed on a drifted DB. All additive.
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS quiz_mode TEXT NOT NULL DEFAULT 'mcq'`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS question_count INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS structured_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE soma_questions ADD COLUMN IF NOT EXISTS mark_scheme TEXT`,
  `ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS structured_marking JSONB`,
  // Student-requested review of AI structured marking (migration 0012).
  `ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS review_requested BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS review_request_note TEXT`,
  `ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMP`,
] as const;

export async function applyBootstrapMigrations() {
  const client = pool ? await pool.connect() : null;
  if (!client) return;

  try {
    for (const query of BOOTSTRAP_QUERIES) {
      try {
        await client.query(query);
      } catch (err: any) {
        // Log but continue — idempotent migrations that fail (e.g. unique index
        // conflicts when duplicates already exist) should not block the server.
        log(`migration warning (non-fatal): ${err.message?.slice(0, 120)}`, "bootstrap");
      }
    }
    log("schema migrations applied", "bootstrap");
  } finally {
    client.release();
  }

  // Provision the private Supabase Storage bucket for PDF uploads. This is
  // best-effort: a failure or missing config must only warn, never block
  // startup. ensureUploadBucket() itself no-ops (with a warning) when storage
  // is unconfigured, so the try/catch here only guards genuine network errors.
  try {
    const { ensureUploadBucket } = await import("./services/fileStorage");
    await ensureUploadBucket();
  } catch (err: any) {
    log(`upload bucket provisioning warning (non-fatal): ${err?.message ?? err}`, "bootstrap");
  }

  // After bootstrap, sanity-check that every table/column declared in
  // shared/schema.ts actually exists in the live DB. If we're here and the
  // verifier still finds drift, it means a column was added to the schema
  // without a matching ALTER above — exactly the failure mode this task
  // exists to prevent.
  if (!pool) return;
  try {
    const drift = await verifySchemaMatchesDb(pool);
    if (!hasDrift(drift)) {
      log("schema drift check passed", "bootstrap");
      return;
    }

    const detail = formatDriftReport(drift);
    const summary =
      `Schema drift detected after bootstrap migrations.\n${detail}\n` +
      `Add the missing CREATE/ALTER statements to BOOTSTRAP_QUERIES in server/bootstrap.ts.`;

    if (process.env.NODE_ENV === "production") {
      log(`FATAL: ${summary}`, "bootstrap");
      throw new Error(summary);
    }
    log(`WARNING: ${summary}`, "bootstrap");
  } catch (err: any) {
    if (process.env.NODE_ENV === "production") {
      // Re-throw so server/index.ts kills the process before it accepts
      // traffic against a half-migrated DB.
      throw err;
    }
    log(`schema drift check failed (non-fatal in dev): ${err.message ?? err}`, "bootstrap");
  }
}
