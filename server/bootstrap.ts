import { pool } from "./db";

const BOOTSTRAP_QUERIES = [
  `ALTER TABLE soma_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student'`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES soma_users(id) ON DELETE SET NULL`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS time_limit_minutes INTEGER NOT NULL DEFAULT 60`,
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
  `CREATE TABLE IF NOT EXISTS syllabus_documents (id SERIAL PRIMARY KEY, tutor_id UUID REFERENCES soma_users(id) ON DELETE SET NULL, board TEXT NOT NULL, level TEXT NOT NULL, syllabus_code TEXT NOT NULL, filename TEXT NOT NULL, extracted_text TEXT NOT NULL, uploaded_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS syllabus_chunks (id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES syllabus_documents(id) ON DELETE CASCADE, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, content_preview TEXT NOT NULL)`,
  // Syllabus document extended columns (curriculum ingestion system)
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'syllabus'`,
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS subject TEXT`,
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS original_path TEXT`,
  `ALTER TABLE syllabus_documents ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  // Unique index on soma_reports to prevent duplicate submissions at DB level
  `CREATE UNIQUE INDEX IF NOT EXISTS soma_reports_quiz_student_idx ON soma_reports(quiz_id, student_id) WHERE student_id IS NOT NULL`,
] as const;

function logBootstrap(message: string) {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [bootstrap] ${message}`);
}

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
        logBootstrap(`migration warning (non-fatal): ${err.message?.slice(0, 120)}`);
      }
    }
    logBootstrap("schema migrations applied");
  } finally {
    client.release();
  }
}
