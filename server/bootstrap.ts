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

  // ── Syllabus Intelligence Layer ──────────────────────────────────────────
  // Body-agnostic tables powering the Cambridge assessment builder and later
  // learner diagnosis. See shared/schema.ts for schema docs.
  `CREATE TABLE IF NOT EXISTS examining_bodies (id SERIAL PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT true, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS examining_bodies_code_idx ON examining_bodies(code)`,
  `CREATE TABLE IF NOT EXISTS curriculum_levels (id SERIAL PRIMARY KEY, body_id INTEGER NOT NULL REFERENCES examining_bodies(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS curriculum_levels_body_code_idx ON curriculum_levels(body_id, code)`,
  `CREATE TABLE IF NOT EXISTS curriculum_subjects (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS curriculum_subjects_slug_idx ON curriculum_subjects(slug)`,
  `CREATE TABLE IF NOT EXISTS syllabi (id SERIAL PRIMARY KEY, body_id INTEGER NOT NULL REFERENCES examining_bodies(id) ON DELETE CASCADE, subject_id INTEGER NOT NULL REFERENCES curriculum_subjects(id) ON DELETE CASCADE, code TEXT NOT NULL, title TEXT NOT NULL, years_valid TEXT, level_id INTEGER REFERENCES curriculum_levels(id) ON DELETE SET NULL, document_id INTEGER REFERENCES syllabus_documents(id) ON DELETE SET NULL, source_path TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS syllabi_body_code_idx ON syllabi(body_id, code)`,
  `CREATE TABLE IF NOT EXISTS papers (id SERIAL PRIMARY KEY, syllabus_id INTEGER NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE, level_id INTEGER NOT NULL REFERENCES curriculum_levels(id) ON DELETE CASCADE, paper_number TEXT NOT NULL, code TEXT, title TEXT NOT NULL, duration_minutes INTEGER, marks INTEGER, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS papers_syllabus_number_idx ON papers(syllabus_id, paper_number)`,
  `CREATE TABLE IF NOT EXISTS topics (id SERIAL PRIMARY KEY, syllabus_id INTEGER NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE, code TEXT, name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS topics_syllabus_name_idx ON topics(syllabus_id, name)`,
  `CREATE TABLE IF NOT EXISTS subtopics (id SERIAL PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, code TEXT, name TEXT NOT NULL, description TEXT, learning_requirements JSONB NOT NULL DEFAULT '[]'::jsonb, sort_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS subtopics_topic_name_idx ON subtopics(topic_id, name)`,
  `CREATE TABLE IF NOT EXISTS competencies (id SERIAL PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS competencies_code_idx ON competencies(code)`,
  `CREATE TABLE IF NOT EXISTS topic_competencies (id SERIAL PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, competency_id INTEGER NOT NULL REFERENCES competencies(id) ON DELETE CASCADE, weight INTEGER NOT NULL DEFAULT 1)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS topic_competencies_unique_idx ON topic_competencies(topic_id, competency_id)`,
  `CREATE TABLE IF NOT EXISTS subtopic_competencies (id SERIAL PRIMARY KEY, subtopic_id INTEGER NOT NULL REFERENCES subtopics(id) ON DELETE CASCADE, competency_id INTEGER NOT NULL REFERENCES competencies(id) ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS subtopic_competencies_unique_idx ON subtopic_competencies(subtopic_id, competency_id)`,
  `CREATE TABLE IF NOT EXISTS paper_topics (id SERIAL PRIMARY KEY, paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS paper_topics_unique_idx ON paper_topics(paper_id, topic_id)`,
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
