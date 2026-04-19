import { sql, relations } from "drizzle-orm";
import { pgTable, text, integer, timestamp, json, jsonb, serial, uuid, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { insertQuizSchema, insertQuestionSchema, insertStudentSchema, insertSubmissionSchema, questionUploadSchema } from "./legacySchemas";


export const graphPlotTypeSchema = z.enum(["line", "curve", "scatter", "points"]);

// A single curve/series on a graph
export const graphCurveSchema = z.object({
  equation: z.string(),                // math expression in x, e.g. "2*x + 1"
  label: z.string().optional(),        // display label in legend (e.g. "y = 2x + 1", "Supply", "v = 3t")
  color: z.string().optional(),        // CSS color override; auto-assigned if omitted
});

export const graphQuestionSpecSchema = z.object({
  plotType: graphPlotTypeSchema,
  // Single-curve shorthand (backward compat) — used when only one equation
  equation: z.string().optional(),
  // Human-readable label for the single-curve case (e.g. "y = sin x", "y = 2x + 1")
  // When provided, this is displayed instead of the raw JS equation expression.
  label: z.string().optional(),
  // Multi-curve: 2–4 curves, each with own equation, optional label and color
  curves: z.array(graphCurveSchema).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional() })).optional(),
  xRange: z.tuple([z.number(), z.number()]),
  yRange: z.tuple([z.number(), z.number()]),
  axisLabels: z.object({ x: z.string().default("x"), y: z.string().default("y") }).default({ x: "x", y: "y" }),
  showGrid: z.boolean().default(true),
  tickInterval: z.number().positive().default(1),
  highlightedPoints: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional() })).optional(),
  asymptotes: z.object({
    vertical: z.array(z.number()).default([]),
    horizontal: z.array(z.number()).default([]),
    oblique: z.array(z.string()).default([]),
  }).optional(),
  implicit: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("circle"),
      h: z.number(),
      k: z.number(),
      r: z.number().positive(),
    }),
    z.object({
      type: z.literal("equation"),
      equation: z.string(),
    }),
  ]).optional(),
  parametric: z.object({
    xEquation: z.string(),
    yEquation: z.string(),
    tRange: z.tuple([z.number(), z.number()]),
  }).optional(),
  piecewise: z.array(z.object({
    equation: z.string(),
    domain: z.tuple([z.number(), z.number()]),
    label: z.string().optional(),
  })).optional(),
  subjectPreset: z.enum(["mathematics", "physics", "economics", "business", "chemistry", "biology"]).optional(),
  graphKind: z.string().optional(),
  // Cambridge-aware graph/diagram metadata (non-breaking extension)
  examBoard: z.string().optional(),
  level: z.string().optional(),
  subjectCode: z.string().optional(),
  syllabusRange: z.string().optional(),
  paperContext: z.string().optional(),
  graphFamily: z.string().optional(),
  scaleSettings: z.object({
    xTick: z.number().positive().optional(),
    yTick: z.number().positive().optional(),
    useFalseOrigin: z.boolean().optional(),
    gridUtilizationTarget: z.number().min(0).max(1).optional(),
  }).optional(),
  seriesStyle: z.object({
    marker: z.enum(["cross", "plus", "dot", "circled_dot"]).optional(),
    line: z.enum(["straight", "smooth", "piecewise"]).optional(),
    thickness: z.number().positive().optional(),
    hatchPattern: z.string().optional(),
  }).optional(),
  legendKey: z.array(z.object({
    label: z.string(),
    marker: z.string().optional(),
    hatch: z.string().optional(),
  })).optional(),
  validationTargets: z.object({
    requireUnits: z.boolean().optional(),
    requireFrequencyDensityLabel: z.boolean().optional(),
    requireErrorBars: z.boolean().optional(),
    requireBestFit: z.boolean().optional(),
  }).optional(),
  errorBars: z.array(z.object({
    x: z.number(),
    y: z.number(),
    xError: z.number().nonnegative().optional(),
    yError: z.number().nonnegative().optional(),
  })).optional(),
  sourceContext: z.object({
    commandWords: z.array(z.string()).optional(),
    skillType: z.string().optional(),
    intent: z.string().optional(),
  }).optional(),
  auditNotes: z.array(z.string()).optional(),
});

export type GraphQuestionSpec = z.infer<typeof graphQuestionSpecSchema>;

export const somaUsers = pgTable("soma_users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: text("role").notNull().default("student"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const somaQuizzes = pgTable("soma_quizzes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  topic: text("topic").notNull(),
  // Ordered list of curriculum topic names the quiz is about. `topic` (above)
  // stays populated for backwards compatibility and AI-pipeline code that
  // expects a single string — it mirrors `topics[0]` when topics is set.
  topics: jsonb("topics").$type<string[]>().notNull().default([]),
  syllabus: text("syllabus").default("IEB"),
  level: text("level").default("Grade 6-12"),
  subject: text("subject"),
  curriculumContext: text("curriculum_context"),
  authorId: uuid("author_id").references(() => somaUsers.id, { onDelete: "set null" }),
  timeLimitMinutes: integer("time_limit_minutes").notNull().default(60),
  status: text("status").notNull().default("published"),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const somaQuestions = pgTable("soma_questions", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id").notNull().references(() => somaQuizzes.id, { onDelete: "cascade" }),
  stem: text("stem").notNull(),
  options: json("options").$type<string[]>().notNull(),
  correctAnswer: text("correct_answer").notNull(),
  explanation: text("explanation").notNull(),
  marks: integer("marks").notNull().default(1),
  questionType: text("question_type").notNull().default("multiple_choice"),
  graphSpec: jsonb("graph_spec").$type<GraphQuestionSpec | null>(),
  topicTag: text("topic_tag"),
  subtopicTag: text("subtopic_tag"),
  difficultyTag: text("difficulty_tag"),
});


export const syllabusDocuments = pgTable("syllabus_documents", {
  id: serial("id").primaryKey(),
  tutorId: uuid("tutor_id").references(() => somaUsers.id, { onDelete: "set null" }),
  board: text("board").notNull(),
  level: text("level").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  filename: text("filename").notNull(),
  extractedText: text("extracted_text").notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  documentType: text("document_type").notNull().default("syllabus"),
  subject: text("subject"),
  originalPath: text("original_path"),
  contentHash: text("content_hash"),
});

export const syllabusChunks = pgTable("syllabus_chunks", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => syllabusDocuments.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  contentPreview: text("content_preview").notNull(),
});

export const somaReports = pgTable("soma_reports", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id").notNull().references(() => somaQuizzes.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").references(() => somaUsers.id, { onDelete: "set null" }),
  studentName: text("student_name").notNull(),
  score: integer("score").notNull(),
  status: text("status").notNull().default("pending"),
  aiFeedbackHtml: text("ai_feedback_html"),
  answersJson: jsonb("answers_json"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tutorStudents = pgTable("tutor_students", {
  id: serial("id").primaryKey(),
  tutorId: uuid("tutor_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("tutor_student_unique_idx").on(table.tutorId, table.studentId),
]);

export const quizAssignments = pgTable("quiz_assignments", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id").notNull().references(() => somaQuizzes.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("quiz_assignment_unique_idx").on(table.quizId, table.studentId),
]);

export const passwordResetRequests = pgTable("password_reset_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tutorComments = pgTable("tutor_comments", {
  id: serial("id").primaryKey(),
  tutorId: uuid("tutor_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  comment: text("comment").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const studentSubjects = pgTable("student_subjects", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  examBody: text("exam_body").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  level: text("level").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const studentTopicMastery = pgTable("student_topic_mastery", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  topic: text("topic").notNull(),
  subtopic: text("subtopic"),
  understandingPercent: integer("understanding_percent").notNull().default(0),
  masteryAchieved: boolean("mastery_achieved").notNull().default(false),
  covered: boolean("covered").notNull().default(false),
  tested: boolean("tested").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  totalQuestions: integer("total_questions").notNull().default(0),
  correctQuestions: integer("correct_questions").notNull().default(0),
  confidenceLevel: text("confidence_level").notNull().default("low"),
  lastTestedAt: timestamp("last_tested_at"),
  nextReviewAt: timestamp("next_review_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("student_topic_mastery_unique_idx").on(table.studentId, table.subject, table.topic, table.subtopic),
]);

export const tutorNotifications = pgTable("tutor_notifications", {
  id: serial("id").primaryKey(),
  tutorId: uuid("tutor_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").references(() => somaUsers.id, { onDelete: "set null" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  payload: jsonb("payload"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const suggestedAssessments = pgTable("suggested_assessments", {
  id: serial("id").primaryKey(),
  tutorId: uuid("tutor_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  purpose: text("purpose").notNull(),
  rationale: text("rationale").notNull(),
  topic: text("topic").notNull(),
  subtopic: text("subtopic"),
  targetDifficulty: text("target_difficulty").notNull().default("medium"),
  status: text("status").notNull().default("suggested"),
  generatedQuizId: integer("generated_quiz_id").references(() => somaQuizzes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Structured misconceptions extracted from examiner reports via AI
export const examinerMisconceptions = pgTable("examiner_misconceptions", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => syllabusDocuments.id, { onDelete: "cascade" }),
  board: text("board").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  subject: text("subject"),
  topic: text("topic").notNull(),
  subtopic: text("subtopic"),
  misconception: text("misconception").notNull(),
  studentError: text("student_error").notNull(),
  correctApproach: text("correct_approach").notNull(),
  frequency: text("frequency").notNull().default("common"),
  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
});

// Notifications shown to students on their dashboard. Generated when a tutor
// assigns a quiz, when feedback is ready, or when the student hits a milestone.
// Time-derived items like "due today" are computed at read-time and merged on
// the server, so this table only stores durable events.
export const studentNotifications = pgTable("student_notifications", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  payload: jsonb("payload"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Question-level flag raised by a student during a quiz. The issuing tutor
// (quiz author) can see these and analyse them later; the in-progress quiz
// attempt is not interrupted.
export const flaggedQuestions = pgTable("flagged_questions", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  questionId: integer("question_id").notNull().references(() => somaQuestions.id, { onDelete: "cascade" }),
  quizId: integer("quiz_id").notNull().references(() => somaQuizzes.id, { onDelete: "cascade" }),
  reportId: integer("report_id").references(() => somaReports.id, { onDelete: "set null" }),
  reason: text("reason"),
  resolvedAt: timestamp("resolved_at"),
  tutorViewedAt: timestamp("tutor_viewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("flagged_question_unique_idx").on(table.studentId, table.questionId),
]);

// ────────────────────────────────────────────────────────────────────────────
// Syllabus Intelligence Layer
//
// These tables power the tutor assessment builder and future learner
// diagnosis. They are intentionally body-agnostic: Cambridge is the first
// examining body seeded, but Edexcel/AQA/OCR/IB can be added as data changes
// without schema work.
//
//   examining_bodies       – Cambridge, Edexcel, …
//   levels                 – IGCSE / AS / A2 (per-body, because bodies differ)
//   subjects               – canonical subject catalogue (Mathematics, …)
//   syllabi                – one row per issued syllabus (code, years, pdf)
//   papers                 – paper structure; each paper belongs to a LEVEL
//                            so AS vs A2 is split here, even when they share
//                            a syllabus code (e.g. 9709)
//   topics                 – top-level syllabus topics (shown to tutors)
//   subtopics              – fine-grained syllabus subtopics (hidden from UI
//                            but retrieved by the copilot for grounding)
//   competencies           – canonical skill tags (knowledge, application…)
//   topic_competencies     – which competencies a topic weights (many-to-many)
//   subtopic_competencies  – fine-grained mapping for diagnosis
//   paper_topics           – which topics each paper examines (drives the
//                            AS/A2 filter in the builder)
// ────────────────────────────────────────────────────────────────────────────

export const examiningBodies = pgTable("examining_bodies", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("examining_bodies_code_idx").on(table.code),
]);

export const curriculumLevels = pgTable("curriculum_levels", {
  id: serial("id").primaryKey(),
  bodyId: integer("body_id").notNull().references(() => examiningBodies.id, { onDelete: "cascade" }),
  code: text("code").notNull(),          // IGCSE, AS, A2
  name: text("name").notNull(),          // "IGCSE", "AS Level", "A2 Level"
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  uniqueIndex("curriculum_levels_body_code_idx").on(table.bodyId, table.code),
]);

export const curriculumSubjects = pgTable("curriculum_subjects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),               // "Mathematics"
  slug: text("slug").notNull(),               // "mathematics"
  description: text("description"),
}, (table) => [
  uniqueIndex("curriculum_subjects_slug_idx").on(table.slug),
]);

export const syllabi = pgTable("syllabi", {
  id: serial("id").primaryKey(),
  bodyId: integer("body_id").notNull().references(() => examiningBodies.id, { onDelete: "cascade" }),
  subjectId: integer("subject_id").notNull().references(() => curriculumSubjects.id, { onDelete: "cascade" }),
  code: text("code").notNull(),               // e.g. "9709", "0580"
  title: text("title").notNull(),             // e.g. "Cambridge International AS & A Level Mathematics"
  yearsValid: text("years_valid"),            // e.g. "2028-2030"
  // If the syllabus spans multiple levels (AS + A2 on one code), leave levelId
  // null and derive the split via papers.levelId. IGCSE uses its own syllabi
  // and sets levelId to the IGCSE level row.
  levelId: integer("level_id").references(() => curriculumLevels.id, { onDelete: "set null" }),
  documentId: integer("document_id").references(() => syllabusDocuments.id, { onDelete: "set null" }),
  sourcePath: text("source_path"),            // relative path to the PDF
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("syllabi_body_code_idx").on(table.bodyId, table.code),
]);

export const papers = pgTable("papers", {
  id: serial("id").primaryKey(),
  syllabusId: integer("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  levelId: integer("level_id").notNull().references(() => curriculumLevels.id, { onDelete: "cascade" }),
  paperNumber: text("paper_number").notNull(),  // "1", "3", "4", etc.
  code: text("code"),                           // e.g. "9709/1", "0580/2"
  title: text("title").notNull(),               // "Pure Mathematics 1"
  durationMinutes: integer("duration_minutes"),
  marks: integer("marks"),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  uniqueIndex("papers_syllabus_number_idx").on(table.syllabusId, table.paperNumber),
]);

export const topics = pgTable("topics", {
  id: serial("id").primaryKey(),
  syllabusId: integer("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  code: text("code"),                      // optional, syllabus-specific (e.g. "1.1")
  name: text("name").notNull(),            // "Quadratics"
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  uniqueIndex("topics_syllabus_name_idx").on(table.syllabusId, table.name),
]);

export const subtopics = pgTable("subtopics", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  code: text("code"),
  name: text("name").notNull(),
  description: text("description"),
  learningRequirements: jsonb("learning_requirements").$type<string[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  uniqueIndex("subtopics_topic_name_idx").on(table.topicId, table.name),
]);

export const competencies = pgTable("competencies", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),           // "knowledge", "application", …
  name: text("name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  uniqueIndex("competencies_code_idx").on(table.code),
]);

export const topicCompetencies = pgTable("topic_competencies", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  competencyId: integer("competency_id").notNull().references(() => competencies.id, { onDelete: "cascade" }),
  weight: integer("weight").notNull().default(1),   // 1..5, used later for diagnosis
}, (table) => [
  uniqueIndex("topic_competencies_unique_idx").on(table.topicId, table.competencyId),
]);

export const subtopicCompetencies = pgTable("subtopic_competencies", {
  id: serial("id").primaryKey(),
  subtopicId: integer("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
  competencyId: integer("competency_id").notNull().references(() => competencies.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("subtopic_competencies_unique_idx").on(table.subtopicId, table.competencyId),
]);

export const paperTopics = pgTable("paper_topics", {
  id: serial("id").primaryKey(),
  paperId: integer("paper_id").notNull().references(() => papers.id, { onDelete: "cascade" }),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("paper_topics_unique_idx").on(table.paperId, table.topicId),
]);

export type ExaminingBody = typeof examiningBodies.$inferSelect;
export type CurriculumLevelRow = typeof curriculumLevels.$inferSelect;
export type CurriculumSubject = typeof curriculumSubjects.$inferSelect;
export type Syllabus = typeof syllabi.$inferSelect;
export type Paper = typeof papers.$inferSelect;
export type Topic = typeof topics.$inferSelect;
export type Subtopic = typeof subtopics.$inferSelect;
export type Competency = typeof competencies.$inferSelect;
export type TopicCompetency = typeof topicCompetencies.$inferSelect;
export type SubtopicCompetency = typeof subtopicCompetencies.$inferSelect;
export type PaperTopic = typeof paperTopics.$inferSelect;

// Structured topic inventory extracted from syllabus documents via AI
export const syllabusTopicInventory = pgTable("syllabus_topic_inventory", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => syllabusDocuments.id, { onDelete: "cascade" }),
  board: text("board").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  subject: text("subject"),
  topic: text("topic").notNull(),
  subtopic: text("subtopic"),
  description: text("description"),
  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
});

export const somaQuizzesRelations = relations(somaQuizzes, ({ one, many }) => ({
  questions: many(somaQuestions),
  reports: many(somaReports),
  assignments: many(quizAssignments),
  author: one(somaUsers, {
    fields: [somaQuizzes.authorId],
    references: [somaUsers.id],
  }),
}));

export const somaQuestionsRelations = relations(somaQuestions, ({ one }) => ({
  quiz: one(somaQuizzes, {
    fields: [somaQuestions.quizId],
    references: [somaQuizzes.id],
  }),
}));

export const somaUsersRelations = relations(somaUsers, ({ many }) => ({
  reports: many(somaReports),
  tutoredStudents: many(tutorStudents, { relationName: "tutorToStudents" }),
  tutors: many(tutorStudents, { relationName: "studentToTutors" }),
  quizAssignments: many(quizAssignments),
}));

export const somaReportsRelations = relations(somaReports, ({ one }) => ({
  quiz: one(somaQuizzes, {
    fields: [somaReports.quizId],
    references: [somaQuizzes.id],
  }),
  student: one(somaUsers, {
    fields: [somaReports.studentId],
    references: [somaUsers.id],
  }),
}));

export const tutorStudentsRelations = relations(tutorStudents, ({ one }) => ({
  tutor: one(somaUsers, {
    fields: [tutorStudents.tutorId],
    references: [somaUsers.id],
    relationName: "tutorToStudents",
  }),
  student: one(somaUsers, {
    fields: [tutorStudents.studentId],
    references: [somaUsers.id],
    relationName: "studentToTutors",
  }),
}));

export const quizAssignmentsRelations = relations(quizAssignments, ({ one }) => ({
  quiz: one(somaQuizzes, {
    fields: [quizAssignments.quizId],
    references: [somaQuizzes.id],
  }),
  student: one(somaUsers, {
    fields: [quizAssignments.studentId],
    references: [somaUsers.id],
  }),
}));

export const STANDARDIZED_SUBJECTS = [
  "Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "Economics",
  "Business Studies",
  "English",
  "Computer Science",
  "Accounting",
  "Geography",
  "History",
] as const;

export const insertSomaUserSchema = createInsertSchema(somaUsers).omit({ createdAt: true, lastLoginAt: true });
export const insertSomaQuizSchema = createInsertSchema(somaQuizzes, {
  // Override the zod inference for the jsonb `topics` column: drizzle-zod
  // infers a ReadonlyArray-ish shape that clashes with downstream `string[]`
  // assignments. Optional because the DB column has a `'[]'::jsonb` default.
  topics: z.array(z.string()).optional(),
}).omit({ id: true, createdAt: true });
export const insertSomaQuestionSchema = createInsertSchema(somaQuestions).omit({ id: true });
export const insertSyllabusDocumentSchema = createInsertSchema(syllabusDocuments).omit({ id: true, uploadedAt: true });
export const insertSyllabusChunkSchema = createInsertSchema(syllabusChunks).omit({ id: true });
export const insertSomaReportSchema = createInsertSchema(somaReports).omit({ id: true, createdAt: true });

export type SomaUser = typeof somaUsers.$inferSelect;
export type InsertSomaUser = z.infer<typeof insertSomaUserSchema>;
export type SomaQuiz = typeof somaQuizzes.$inferSelect;
export type InsertSomaQuiz = z.infer<typeof insertSomaQuizSchema>;
export type SomaQuestion = typeof somaQuestions.$inferSelect;
export type InsertSomaQuestion = z.infer<typeof insertSomaQuestionSchema>;
export type SyllabusDocument = typeof syllabusDocuments.$inferSelect;
export type InsertSyllabusDocument = z.infer<typeof insertSyllabusDocumentSchema>;
export type SyllabusChunk = typeof syllabusChunks.$inferSelect;
export type InsertSyllabusChunk = z.infer<typeof insertSyllabusChunkSchema>;
export type SomaReport = typeof somaReports.$inferSelect;
export type InsertSomaReport = z.infer<typeof insertSomaReportSchema>;

export const insertTutorStudentSchema = createInsertSchema(tutorStudents).omit({ id: true, createdAt: true });
export const insertQuizAssignmentSchema = createInsertSchema(quizAssignments).omit({ id: true, createdAt: true });

export type TutorStudent = typeof tutorStudents.$inferSelect;
export type InsertTutorStudent = z.infer<typeof insertTutorStudentSchema>;
export type QuizAssignment = typeof quizAssignments.$inferSelect;
export type InsertQuizAssignment = z.infer<typeof insertQuizAssignmentSchema>;

export const insertTutorCommentSchema = createInsertSchema(tutorComments).omit({ id: true, createdAt: true });
export type TutorComment = typeof tutorComments.$inferSelect;
export type InsertTutorComment = z.infer<typeof insertTutorCommentSchema>;

export const insertStudentSubjectSchema = createInsertSchema(studentSubjects).omit({ id: true, createdAt: true, updatedAt: true });
export type StudentSubject = typeof studentSubjects.$inferSelect;
export type InsertStudentSubject = z.infer<typeof insertStudentSubjectSchema>;

export const insertTutorNotificationSchema = createInsertSchema(tutorNotifications).omit({ id: true, createdAt: true, readAt: true });
export type TutorNotification = typeof tutorNotifications.$inferSelect;
export type InsertTutorNotification = z.infer<typeof insertTutorNotificationSchema>;

export const insertStudentTopicMasterySchema = createInsertSchema(studentTopicMastery).omit({ id: true, updatedAt: true });
export type StudentTopicMastery = typeof studentTopicMastery.$inferSelect;
export type InsertStudentTopicMastery = z.infer<typeof insertStudentTopicMasterySchema>;

export const insertSuggestedAssessmentSchema = createInsertSchema(suggestedAssessments).omit({ id: true, createdAt: true });
export type SuggestedAssessment = typeof suggestedAssessments.$inferSelect;
export type InsertSuggestedAssessment = z.infer<typeof insertSuggestedAssessmentSchema>;

export const insertExaminerMisconceptionSchema = createInsertSchema(examinerMisconceptions).omit({ id: true, extractedAt: true });
export type ExaminerMisconception = typeof examinerMisconceptions.$inferSelect;
export type InsertExaminerMisconception = z.infer<typeof insertExaminerMisconceptionSchema>;

export const insertSyllabusTopicInventorySchema = createInsertSchema(syllabusTopicInventory).omit({ id: true, extractedAt: true });
export type SyllabusTopicInventoryItem = typeof syllabusTopicInventory.$inferSelect;
export type InsertSyllabusTopicInventoryItem = z.infer<typeof insertSyllabusTopicInventorySchema>;

export const insertStudentNotificationSchema = createInsertSchema(studentNotifications).omit({ id: true, createdAt: true, readAt: true });
export type StudentNotification = typeof studentNotifications.$inferSelect;
export type InsertStudentNotification = z.infer<typeof insertStudentNotificationSchema>;

export const insertFlaggedQuestionSchema = createInsertSchema(flaggedQuestions).omit({ id: true, createdAt: true, resolvedAt: true, tutorViewedAt: true });
export type FlaggedQuestion = typeof flaggedQuestions.$inferSelect;
export type InsertFlaggedQuestion = z.infer<typeof insertFlaggedQuestionSchema>;

// Legacy schemas retained for compatibility with older admin flows and tests.
// The current app stores quiz content in soma_* tables, but these schemas are
// now isolated in `shared/legacySchemas.ts` and re-exported here so existing
// imports continue to work unchanged.
export { insertQuizSchema, insertQuestionSchema, insertStudentSchema, insertSubmissionSchema, questionUploadSchema } from "./legacySchemas";
export type { InsertQuiz, InsertQuestion, InsertStudent, InsertSubmission } from "./legacySchemas";
