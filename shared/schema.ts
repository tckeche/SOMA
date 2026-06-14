import { sql, relations } from "drizzle-orm";
import { pgTable, text, integer, timestamp, json, jsonb, serial, uuid, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";


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

/**
 * Draft question shape used by the assessment builder.
 *
 * Shared between the server's in-memory draft store (`server/routes.ts`) and
 * the client-side builder UI (`client/src/pages/builder.tsx`) so both sides
 * stay in sync. Not a DB row — drafts live only in memory until persisted.
 */
export interface DraftQuestion {
  draftId: string;
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  marks: number;
  questionType: "multiple_choice" | "graph";
  graphSpec?: GraphQuestionSpec | null;
  topicTag?: string | null;
  subtopicTag?: string | null;
  difficultyTag?: string | null;
  // Catalogue + examiner-loop FK columns. Optional on the draft so
  // the in-memory draftStore and the client-sent draft body keep
  // working when these aren't supplied — but when they ARE supplied
  // (i.e. by the AI generation flow), they MUST flow through to the
  // final published soma_questions row, otherwise the publish
  // endpoint silently destroys all the examiner-loop attribution
  // the Maker just computed.
  subtopicId?: number | null;
  learningRequirementId?: number | null;
  targetMisconceptionIds?: number[] | null;
  commandWord?: string | null;
  assessmentObjective?: string | null;
  optionRationales?: Array<{
    option: string;
    isCorrect: boolean;
    rationale: string;
    misconceptionId: number | null;
  }> | null;
}

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
  // FK migration (Phase 1): nullable structural keys into the catalogue tree.
  // Free-text *Tag columns above are retained during the dual-write window;
  // backfill scripts populate these IDs over time. New code should prefer the
  // ID columns and treat the tag columns as advisory only.
  subtopicId: integer("subtopic_id").references(() => subtopics.id, { onDelete: "set null" }),
  learningRequirementId: integer("learning_requirement_id").references(() => learningRequirements.id, { onDelete: "set null" }),
  // Distractor → examiner-misconception link (jsonb int[]). Phase 2 quiz
  // generation will populate this so marking can cite the matched insight.
  targetMisconceptionIds: jsonb("target_misconception_ids").$type<number[]>(),
  // Cached command word (e.g. "state", "explain", "evaluate") and AO label
  // for command-word coaching and AO rollups. Populated at generation/import
  // time; nullable so legacy questions don't block reads.
  commandWord: text("command_word"),
  assessmentObjective: text("assessment_objective"),
  // Phase 4 — per-option rationales emitted by the verifier. Null on legacy
  // rows; on new rows it's a 4-entry array (one per option, in the same
  // order as `options`). Each entry: { option, isCorrect, rationale,
  // misconceptionId }. Marker uses `misconceptionId` to attribute a wrong
  // answer to the specific examiner-flagged seed and surface it in the
  // tutor's misconception report.
  optionRationales: jsonb("option_rationales").$type<Array<{
    option: string;
    isCorrect: boolean;
    rationale: string;
    misconceptionId: number | null;
  }>>(),
  // Phase 5 review gate. Default "approved" so existing/legacy rows stay
  // servable; the generation quality gate sets "needs_review"/"auto_blocked"
  // explicitly on new questions.
  reviewStatus: text("review_status").notNull().default("approved"),
  // Audit trail of how this question was generated (models, prompt version,
  // prover result, warnings, requested-vs-actual difficulty, block reason).
  generationMeta: jsonb("generation_meta").$type<{
    makerModel?: string; verifierModel?: string; promptVersion?: string;
    proverPattern?: string | null;
    warnings?: Array<{ questionIndex: number; field: string; issue: string; autoFixed: boolean }>;
    requestedDifficulty?: "easy" | "medium" | "hard";
    blocked?: boolean; blockReason?: string;
  }>(),
});


/**
 * ⚠️  LEGACY (Phase 10) — predates the structured catalogue. The new
 *     catalogue stack (`examiningBodies` → `syllabi` → `topics` →
 *     `subtopics` → `learningRequirements` + `topicEmbeddings`) is the
 *     primary source for copilot / SOMA context. These PDF-derived text
 *     chunks are retained as optional supporting text for syllabi not yet
 *     in the catalogue and will be retired once full catalogue coverage
 *     is in place.
 */
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
  // Tutor manual per-question marks override: map of questionId (string) ->
  // awardedMarks (int). Null/absent means "no override; use computed marks".
  // Honoured by recomputeReportScore so regrade never clobbers manual marks.
  manualMarks: jsonb("manual_marks").$type<Record<string, number>>(),
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
  // FK migration (Phase 1): structural keys into the catalogue tree.
  // Nullable during the dual-write window; backfilled by
  // scripts/backfillMasterySubtopicIds.ts. The free-text columns above
  // remain authoritative until backfill is complete.
  subtopicId: integer("subtopic_id").references(() => subtopics.id, { onDelete: "set null" }),
  learningRequirementId: integer("learning_requirement_id").references(() => learningRequirements.id, { onDelete: "set null" }),
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

// Structured misconceptions extracted from examiner reports via AI.
// Phase 1 adds FK linkage into the catalogue + review-queue / provenance
// fields. Existing rows remain valid: the new fields are nullable and
// status defaults to "approved" so legacy data stays visible until a
// review pass marks any of it as "pending".
export const examinerMisconceptions = pgTable("examiner_misconceptions", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => syllabusDocuments.id, { onDelete: "cascade" }),
  board: text("board").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  subject: text("subject"),
  topic: text("topic").notNull(),
  subtopic: text("subtopic"),
  // FK linkage to the catalogue tree (nullable during dual-write).
  subtopicId: integer("subtopic_id").references(() => subtopics.id, { onDelete: "set null" }),
  learningRequirementId: integer("learning_requirement_id").references(() => learningRequirements.id, { onDelete: "set null" }),
  misconception: text("misconception").notNull(),
  studentError: text("student_error").notNull(),
  correctApproach: text("correct_approach").notNull(),
  frequency: text("frequency").notNull().default("common"),
  // Phase 2 review queue. Default "approved" means existing rows stay
  // visible to consumers; new AI-extracted rows will land as "pending".
  status: text("status").notNull().default("approved"),
  reviewedById: uuid("reviewed_by_id").references(() => somaUsers.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  reviewNotes: text("review_notes"),
  // Provenance — verbatim quote and source page so the dashboard can show
  // the evidence behind every insight. Populated by the new chunked
  // extractor in Phase 2; nullable so legacy rows still load.
  sourceQuote: text("source_quote"),
  sourcePage: integer("source_page"),
  // Self-confidence score from the extraction pass (0..1). Helps the
  // queue auto-prioritise low-confidence rows.
  confidence: integer("confidence_pct"),
  // Year the source examiner report was published (e.g. 2024). Parsed
  // from the document filename at extraction time. Used by the student
  // review UI to render "Cambridge examiners flagged this in 2024."
  examYear: integer("exam_year"),
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

// ─────────────────────────────────────────────────────────────────────────────
// Syllabus intelligence layer (Phase 2 of the Cambridge assessment feature)
//
// Models the hierarchy:
//   examining_bodies → subjects → syllabi → { papers, strands, topics }
//   topics → subtopics → learning_requirements
//   learning_requirements ↔ competencies (many-to-many via join table)
//   papers ↔ topics (many-to-many) and papers ↔ subtopics (many-to-many)
//
// levelTier ("IGCSE" | "AS" | "A2") is authoritative on subtopics and papers;
// topic-level tier visibility is derived from subtopic tiers and cached in
// topics.levelTiers by the ingestion pipeline (Phase 3).
// ─────────────────────────────────────────────────────────────────────────────

export const examiningBodies = pgTable("examining_bodies", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("examining_bodies_slug_idx").on(t.slug)]);

// Levels are the tutor-facing picker values: "IGCSE", "AS", "A2". `topBand`
// groups AS and A2 under the same A_Level syllabus row, so a tutor picking AS
// or A2 resolves to the same syllabus and we filter topics by levelTier.
export const levels = pgTable("levels", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  displayName: text("display_name").notNull(),
  topBand: text("top_band").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [uniqueIndex("levels_code_idx").on(t.code)]);

export const subjects = pgTable("subjects", {
  id: serial("id").primaryKey(),
  examiningBodyId: integer("examining_body_id").notNull().references(() => examiningBodies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("subjects_body_slug_idx").on(t.examiningBodyId, t.slug)]);

// One row per official syllabus (e.g. Cambridge 9702 Physics). For A Level,
// a single row carries both AS and A2 content; tier is resolved via papers
// and subtopics.
export const syllabi = pgTable("syllabi", {
  id: serial("id").primaryKey(),
  examiningBodyId: integer("examining_body_id").notNull().references(() => examiningBodies.id, { onDelete: "cascade" }),
  subjectId: integer("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
  topBand: text("top_band").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  title: text("title").notNull(),
  yearsValidFrom: integer("years_valid_from"),
  yearsValidTo: integer("years_valid_to"),
  sourceFile: text("source_file"),
  contentHash: text("content_hash"),
  successorSyllabusCode: text("successor_syllabus_code"),
  commandWordGlossary: jsonb("command_word_glossary").$type<Array<{ word: string; meaning: string }>>(),
  notes: jsonb("notes").$type<string[]>(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("syllabi_body_code_idx").on(t.examiningBodyId, t.syllabusCode)]);

export const papers = pgTable("papers", {
  id: serial("id").primaryKey(),
  syllabusId: integer("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  paperNumber: integer("paper_number").notNull(),
  code: text("code"),
  title: text("title").notNull(),
  levelTier: text("level_tier").notNull(),
  coreOrExtended: text("core_or_extended"),
  durationMinutes: integer("duration_minutes"),
  rawMarks: integer("raw_marks"),
  style: text("style"),
  weightingPct: jsonb("weighting_pct").$type<{ AS?: number; ALevel?: number; IGCSE?: number }>(),
  assumesPriorContentFromPaperNumbers: jsonb("assumes_prior_content_from_paper_numbers").$type<number[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("papers_syllabus_number_idx").on(t.syllabusId, t.paperNumber)]);

// Optional topic grouping inside a syllabus (Physical/Inorganic/Organic for
// Chemistry 9701; Pure Mathematics/Mechanics/P&S for Mathematics 9709).
export const syllabusStrands = pgTable("syllabus_strands", {
  id: serial("id").primaryKey(),
  syllabusId: integer("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [uniqueIndex("syllabus_strands_syllabus_name_idx").on(t.syllabusId, t.name)]);

export const topics = pgTable("topics", {
  id: serial("id").primaryKey(),
  syllabusId: integer("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  strandId: integer("strand_id").references(() => syllabusStrands.id, { onDelete: "set null" }),
  topicNumber: text("topic_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  // Derived union of subtopics' levelTiers ("IGCSE" | "AS" | "A2"); kept in
  // sync by the ingestion pipeline so the topic-list API can filter in SQL
  // without a subtopic join.
  levelTiers: jsonb("level_tiers").$type<string[]>().notNull().default([]),
  // Phase 7 enrichment: retrieval + UX metadata. All optional; populated by
  // the ingestion pipeline where available, empty defaults otherwise.
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  sourcePages: jsonb("source_pages").$type<number[]>().notNull().default([]),
  prerequisiteTopicIds: jsonb("prerequisite_topic_ids").$type<number[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("topics_syllabus_number_idx").on(t.syllabusId, t.topicNumber)]);

export const subtopics = pgTable("subtopics", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  subtopicNumber: text("subtopic_number").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  levelTier: text("level_tier").notNull(),
  coreOrExtended: text("core_or_extended"),
  // Phase 7 enrichment: keywords for lexical matching, sourcePages for
  // provenance display in the tutor UI.
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  sourcePages: jsonb("source_pages").$type<number[]>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("subtopics_topic_number_idx").on(t.topicId, t.subtopicNumber)]);

// One "Candidates should be able to …" bullet per row.
export const learningRequirements = pgTable("learning_requirements", {
  id: serial("id").primaryKey(),
  subtopicId: integer("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
  statement: text("statement").notNull(),
  commandWord: text("command_word"),
  notesAndExamples: text("notes_and_examples"),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Reference table of competency tags. Seeded once; rarely mutated.
export const competencies = pgTable("competencies", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [uniqueIndex("competencies_code_idx").on(t.code)]);

// Finest-grained tagging: each learning requirement can exercise multiple
// competencies (e.g. "Calculate …" hits both calculation and application).
export const learningRequirementCompetencies = pgTable("learning_requirement_competencies", {
  id: serial("id").primaryKey(),
  learningRequirementId: integer("learning_requirement_id").notNull().references(() => learningRequirements.id, { onDelete: "cascade" }),
  competencyId: integer("competency_id").notNull().references(() => competencies.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("lr_comp_unique_idx").on(t.learningRequirementId, t.competencyId)]);

// Rollups written by Phase 3 ingestion so the copilot-context endpoint does
// not need to traverse learning_requirements for every call.
export const subtopicCompetencies = pgTable("subtopic_competencies", {
  id: serial("id").primaryKey(),
  subtopicId: integer("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
  competencyId: integer("competency_id").notNull().references(() => competencies.id, { onDelete: "cascade" }),
  weight: integer("weight").notNull().default(1),
}, (t) => [uniqueIndex("subtopic_comp_unique_idx").on(t.subtopicId, t.competencyId)]);

export const topicCompetencies = pgTable("topic_competencies", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  competencyId: integer("competency_id").notNull().references(() => competencies.id, { onDelete: "cascade" }),
  weight: integer("weight").notNull().default(1),
}, (t) => [uniqueIndex("topic_comp_unique_idx").on(t.topicId, t.competencyId)]);

// Paper ↔ topic cross-reference. `weight` is a qualitative tag that lets the
// copilot know whether a paper primarily assesses a topic, covers it, or just
// assumes its content (used for Mathematics 9709 Paper 4 assuming Paper 1).
export const paperTopicMappings = pgTable("paper_topic_mappings", {
  id: serial("id").primaryKey(),
  paperId: integer("paper_id").notNull().references(() => papers.id, { onDelete: "cascade" }),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  weight: text("weight").notNull().default("covered"),
}, (t) => [uniqueIndex("paper_topic_unique_idx").on(t.paperId, t.topicId)]);

// Pattern C (Economics 9708) needs per-subtopic paper coverage because a
// single topic theme carries both AS and A2 subtopics assessed on different
// papers.
export const subtopicPaperMappings = pgTable("subtopic_paper_mappings", {
  id: serial("id").primaryKey(),
  subtopicId: integer("subtopic_id").notNull().references(() => subtopics.id, { onDelete: "cascade" }),
  paperId: integer("paper_id").notNull().references(() => papers.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("subtopic_paper_unique_idx").on(t.subtopicId, t.paperId)]);

// Phase 7 — Reference-text + embeddings layer. One row per (topic, levelTier)
// so AS / A2 cuts of the same topic get their own vectors (a topic's AS
// subset teaches different material from its A2 subset). `contentHash` gates
// regeneration: if the cleaned chunk text hasn't changed, the embedding is
// reused.
export const topicEmbeddings = pgTable("topic_embeddings", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  levelTier: text("level_tier").notNull(),
  chunkText: text("chunk_text").notNull(),
  contentHash: text("content_hash").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  dimensions: integer("dimensions").notNull(),
  // Stored as jsonb number[] — at ~300 topics × 3 tiers × 1536 dims this is
  // tiny (<20 MB) and avoids needing pgvector for the current scale.
  embedding: jsonb("embedding").$type<number[]>().notNull(),
  embeddedAt: timestamp("embedded_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("topic_embeddings_topic_tier_idx").on(t.topicId, t.levelTier)]);

export const assessmentObjectives = pgTable("assessment_objectives", {
  id: serial("id").primaryKey(),
  syllabusId: integer("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  weightingPct: jsonb("weighting_pct").$type<{ AS?: number; ALevel?: number; IGCSE?: number }>(),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [uniqueIndex("assessment_objectives_syllabus_code_idx").on(t.syllabusId, t.code)]);

export const assessmentObjectiveCompetencies = pgTable("assessment_objective_competencies", {
  id: serial("id").primaryKey(),
  assessmentObjectiveId: integer("assessment_objective_id").notNull().references(() => assessmentObjectives.id, { onDelete: "cascade" }),
  competencyId: integer("competency_id").notNull().references(() => competencies.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("ao_comp_unique_idx").on(t.assessmentObjectiveId, t.competencyId)]);

// Canonical list of competency codes the ingestion pipeline and UI can rely
// on. Keep in sync with the `competencies` table seed.
export const COMPETENCY_CODES = [
  "knowledge",
  "understanding",
  "application",
  "calculation",
  "interpretation",
  "analysis",
  "evaluation",
  "problem_solving",
  "practical_skills",
  "communication",
] as const;
export type CompetencyCode = (typeof COMPETENCY_CODES)[number];

export const LEVEL_TIER_VALUES = ["IGCSE", "AS", "A2"] as const;
export type LevelTier = (typeof LEVEL_TIER_VALUES)[number];

export const CORE_OR_EXTENDED_VALUES = ["core", "extended", "practical"] as const;
export type CoreOrExtended = (typeof CORE_OR_EXTENDED_VALUES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — The Examiner Loop
//
// answer_diagnoses     : per-answer record written at grading time. When a
//                        student's chosen distractor maps to a known
//                        examiner misconception we record the link so the
//                        feedback layer can cite the source. When it doesn't,
//                        the row still exists with `misconceptionId = null`
//                        so we can later analyse "we have no diagnosis for X%
//                        of wrong answers — extend the misconception
//                        library."
//
// student_misconceptions : rolled-up evidence per (student, misconception).
//                        Incremented by the marker; not written by hand.
//                        `resolvedAt` is set when the student answers N
//                        consecutive questions on the same misconception
//                        correctly (handled by the diagnosis service).
// ─────────────────────────────────────────────────────────────────────────────

export const answerDiagnoses = pgTable("answer_diagnoses", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").notNull().references(() => somaReports.id, { onDelete: "cascade" }),
  questionId: integer("question_id").notNull().references(() => somaQuestions.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  // Numeric index of the chosen option (0..n-1). Nullable when the student
  // skipped the question.
  chosenOptionIndex: integer("chosen_option_index"),
  chosenOptionText: text("chosen_option_text"),
  correct: boolean("correct").notNull(),
  // Linked examiner misconception when the chosen distractor was seeded
  // from one (see soma_questions.target_misconception_ids). Nullable when
  // there is no match.
  misconceptionId: integer("misconception_id").references(() => examinerMisconceptions.id, { onDelete: "set null" }),
  // Coarse classification: "careless" | "conceptual" | "procedural" |
  // "command_word" | "unknown". Free-text for now to avoid an enum
  // migration; tightened in Phase 4.
  diagnosisCategory: text("diagnosis_category"),
  // Short, examiner-style explanation written by the marker. Templated
  // when misconceptionId is set, AI-written otherwise.
  rationale: text("rationale"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("answer_diagnoses_unique_idx").on(t.reportId, t.questionId),
]);

export const studentMisconceptions = pgTable("student_misconceptions", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  misconceptionId: integer("misconception_id").notNull().references(() => examinerMisconceptions.id, { onDelete: "cascade" }),
  evidenceCount: integer("evidence_count").notNull().default(0),
  // Number of consecutive correct answers on questions targeting this
  // misconception since it was last triggered. Used by the resolver to
  // decide when to set resolvedAt.
  consecutiveCorrect: integer("consecutive_correct").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  // Foreign key into the most recent report that triggered an update —
  // helps the UI link directly to the originating quiz.
  lastReportId: integer("last_report_id").references(() => somaReports.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("student_misconception_unique_idx").on(t.studentId, t.misconceptionId),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3.3 — Personal Revision Plan.
//
// One plan per (student, syllabus). The plan body lives in `weeks` as a
// structured jsonb document; everything else is metadata so we can mark
// the plan stale when the student submits a new quiz, and regenerate on
// demand.
// ─────────────────────────────────────────────────────────────────────────────
export interface RevisionPlanSession {
  topic: string;
  subtopic: string | null;
  durationMinutes: number;
  type: "drill" | "review" | "exam_practice" | "concept_recap" | "examiner_misconception";
  rationale: string;
  understandingPercent: number;
  examinerInsightCount: number;
}

export interface RevisionPlanWeek {
  weekNumber: number;
  label: string;
  focus: string;
  sessions: RevisionPlanSession[];
  totalMinutes: number;
}

export interface RevisionPlanBody {
  examDate: string | null;
  weekHours: number;
  weeks: RevisionPlanWeek[];
  summary: string;
  weakAreas: Array<{ topic: string; understandingPercent: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4.2 — Command-Word Coach.
//
// Per (student, subject, command word) accuracy. Cambridge marks are
// won and lost on command-word literacy ("state" vs "explain" vs
// "evaluate") and aggregating across subtopics shows where the
// student's writing skill — independent of content — is weakest.
//
// We key on a NORMALISED command word (lowercased, trimmed) so e.g.
// "Explain", "explain.", "Explain how" all roll up to "explain".
// ─────────────────────────────────────────────────────────────────────────────
export const commandWordPerformance = pgTable("command_word_performance", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  commandWord: text("command_word").notNull(),
  attempts: integer("attempts").notNull().default(0),
  correct: integer("correct").notNull().default(0),
  marksAttempted: integer("marks_attempted").notNull().default(0),
  marksAwarded: integer("marks_awarded").notNull().default(0),
  lastAttemptedAt: timestamp("last_attempted_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("command_word_performance_unique_idx").on(t.studentId, t.subject, t.commandWord),
]);

export const revisionPlans = pgTable("revision_plans", {
  id: serial("id").primaryKey(),
  studentId: uuid("student_id").notNull().references(() => somaUsers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  examBody: text("exam_body").notNull(),
  syllabusCode: text("syllabus_code").notNull(),
  level: text("level").notNull(),
  examDate: timestamp("exam_date"),
  weekHours: integer("week_hours").notNull().default(6),
  weeks: jsonb("weeks").$type<RevisionPlanWeek[]>().notNull().default([]),
  summary: text("summary").notNull().default(""),
  weakAreas: jsonb("weak_areas").$type<Array<{ topic: string; understandingPercent: number }>>().notNull().default([]),
  // Stale flag — set whenever the student submits a new quiz. UI shows a
  // "Refresh plan" prompt; user has to click it to regenerate.
  stale: boolean("stale").notNull().default(false),
  lastReportId: integer("last_report_id").references(() => somaReports.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("revision_plans_unique_idx").on(t.studentId, t.subject, t.syllabusCode, t.level),
]);

// ─────────────────────────────────────────────────────────────────────────────
// AI usage log — durable per-call telemetry for the super-admin spend dashboard.
//
// One row per AI call (success or failure). The in-memory aggregator in
// `server/services/aiUsageMetrics.ts` keeps live counters; this table is the
// historical record so the super-admin dashboard can show spend by tutor /
// student / day across process restarts.
//
// Privacy: we deliberately store ONLY counters and safe metadata. No raw
// prompt, no raw response, no idempotency key, no request body. The
// telemetry envelope already enforces a 200-char preview elsewhere; we drop
// even that here.
// ─────────────────────────────────────────────────────────────────────────────
export const aiUsageLogs = pgTable("ai_usage_logs", {
  id: serial("id").primaryKey(),
  // SHA-256 prefix from aiTelemetry.recordCall for cross-referencing logs.
  requestId: text("request_id"),
  parentRequestId: text("parent_request_id"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  taskType: text("task_type"),
  promptVersion: text("prompt_version"),
  // App-level operation (e.g. "quiz.generate", "report.grade", "examiner.extract").
  route: text("route"),
  // Owning user for spend attribution. NOT a hard FK — telemetry must never
  // fail because a user row was deleted.
  userId: uuid("user_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  // Stored in micro-USD (1 USD = 1_000_000) to avoid float drift; convert in
  // the read API. Nullable when the price table has no entry for the model.
  costMicroUsd: integer("cost_micro_usd"),
  latencyMs: integer("latency_ms").notNull().default(0),
  success: boolean("success").notNull().default(true),
  validationFailed: boolean("validation_failed").notNull().default(false),
  parseFailed: boolean("parse_failed").notNull().default(false),
  cached: boolean("cached").notNull().default(false),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Relations ───────────────────────────────────────────────────────────────

export const examiningBodiesRelations = relations(examiningBodies, ({ many }) => ({
  subjects: many(subjects),
  syllabi: many(syllabi),
}));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
  examiningBody: one(examiningBodies, {
    fields: [subjects.examiningBodyId],
    references: [examiningBodies.id],
  }),
  syllabi: many(syllabi),
}));

export const syllabiRelations = relations(syllabi, ({ one, many }) => ({
  examiningBody: one(examiningBodies, {
    fields: [syllabi.examiningBodyId],
    references: [examiningBodies.id],
  }),
  subject: one(subjects, {
    fields: [syllabi.subjectId],
    references: [subjects.id],
  }),
  papers: many(papers),
  strands: many(syllabusStrands),
  topics: many(topics),
  assessmentObjectives: many(assessmentObjectives),
}));

export const papersRelations = relations(papers, ({ one, many }) => ({
  syllabus: one(syllabi, {
    fields: [papers.syllabusId],
    references: [syllabi.id],
  }),
  topicMappings: many(paperTopicMappings),
  subtopicMappings: many(subtopicPaperMappings),
}));

export const syllabusStrandsRelations = relations(syllabusStrands, ({ one, many }) => ({
  syllabus: one(syllabi, {
    fields: [syllabusStrands.syllabusId],
    references: [syllabi.id],
  }),
  topics: many(topics),
}));

export const topicsRelations = relations(topics, ({ one, many }) => ({
  syllabus: one(syllabi, {
    fields: [topics.syllabusId],
    references: [syllabi.id],
  }),
  strand: one(syllabusStrands, {
    fields: [topics.strandId],
    references: [syllabusStrands.id],
  }),
  subtopics: many(subtopics),
  paperMappings: many(paperTopicMappings),
  competencies: many(topicCompetencies),
}));

export const subtopicsRelations = relations(subtopics, ({ one, many }) => ({
  topic: one(topics, {
    fields: [subtopics.topicId],
    references: [topics.id],
  }),
  learningRequirements: many(learningRequirements),
  paperMappings: many(subtopicPaperMappings),
  competencies: many(subtopicCompetencies),
}));

export const learningRequirementsRelations = relations(learningRequirements, ({ one, many }) => ({
  subtopic: one(subtopics, {
    fields: [learningRequirements.subtopicId],
    references: [subtopics.id],
  }),
  competencies: many(learningRequirementCompetencies),
}));

export const competenciesRelations = relations(competencies, ({ many }) => ({
  learningRequirements: many(learningRequirementCompetencies),
  subtopics: many(subtopicCompetencies),
  topics: many(topicCompetencies),
  assessmentObjectives: many(assessmentObjectiveCompetencies),
}));

export const paperTopicMappingsRelations = relations(paperTopicMappings, ({ one }) => ({
  paper: one(papers, {
    fields: [paperTopicMappings.paperId],
    references: [papers.id],
  }),
  topic: one(topics, {
    fields: [paperTopicMappings.topicId],
    references: [topics.id],
  }),
}));

export const subtopicPaperMappingsRelations = relations(subtopicPaperMappings, ({ one }) => ({
  paper: one(papers, {
    fields: [subtopicPaperMappings.paperId],
    references: [papers.id],
  }),
  subtopic: one(subtopics, {
    fields: [subtopicPaperMappings.subtopicId],
    references: [subtopics.id],
  }),
}));

export const assessmentObjectivesRelations = relations(assessmentObjectives, ({ one, many }) => ({
  syllabus: one(syllabi, {
    fields: [assessmentObjectives.syllabusId],
    references: [syllabi.id],
  }),
  competencies: many(assessmentObjectiveCompetencies),
}));

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

// ── Syllabus intelligence: insert schemas & select types ────────────────────

export const insertExaminingBodySchema = createInsertSchema(examiningBodies).omit({ id: true, createdAt: true });
export type ExaminingBody = typeof examiningBodies.$inferSelect;
export type InsertExaminingBody = z.infer<typeof insertExaminingBodySchema>;

export const insertLevelSchema = createInsertSchema(levels).omit({ id: true });
export type Level = typeof levels.$inferSelect;
export type InsertLevel = z.infer<typeof insertLevelSchema>;

export const insertSubjectSchema = createInsertSchema(subjects).omit({ id: true, createdAt: true });
export type Subject = typeof subjects.$inferSelect;
export type InsertSubject = z.infer<typeof insertSubjectSchema>;

export const insertSyllabusSchema = createInsertSchema(syllabi, {
  notes: z.array(z.string()).optional(),
  commandWordGlossary: z.array(z.object({ word: z.string(), meaning: z.string() })).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type Syllabus = typeof syllabi.$inferSelect;
export type InsertSyllabus = z.infer<typeof insertSyllabusSchema>;

export const insertPaperSchema = createInsertSchema(papers, {
  assumesPriorContentFromPaperNumbers: z.array(z.number().int().nonnegative()).optional(),
}).omit({ id: true, createdAt: true });
export type Paper = typeof papers.$inferSelect;
export type InsertPaper = z.infer<typeof insertPaperSchema>;

export const insertSyllabusStrandSchema = createInsertSchema(syllabusStrands).omit({ id: true });
export type SyllabusStrand = typeof syllabusStrands.$inferSelect;
export type InsertSyllabusStrand = z.infer<typeof insertSyllabusStrandSchema>;

export const insertTopicSchema = createInsertSchema(topics, {
  levelTiers: z.array(z.string()).optional(),
}).omit({ id: true, createdAt: true });
export type Topic = typeof topics.$inferSelect;
export type InsertTopic = z.infer<typeof insertTopicSchema>;

export const insertSubtopicSchema = createInsertSchema(subtopics).omit({ id: true, createdAt: true });
export type Subtopic = typeof subtopics.$inferSelect;
export type InsertSubtopic = z.infer<typeof insertSubtopicSchema>;

export const insertLearningRequirementSchema = createInsertSchema(learningRequirements).omit({ id: true });
export type LearningRequirement = typeof learningRequirements.$inferSelect;
export type InsertLearningRequirement = z.infer<typeof insertLearningRequirementSchema>;

export const insertCompetencySchema = createInsertSchema(competencies).omit({ id: true });
export type Competency = typeof competencies.$inferSelect;
export type InsertCompetency = z.infer<typeof insertCompetencySchema>;

export const insertLearningRequirementCompetencySchema = createInsertSchema(learningRequirementCompetencies).omit({ id: true });
export type LearningRequirementCompetency = typeof learningRequirementCompetencies.$inferSelect;
export type InsertLearningRequirementCompetency = z.infer<typeof insertLearningRequirementCompetencySchema>;

export const insertSubtopicCompetencySchema = createInsertSchema(subtopicCompetencies).omit({ id: true });
export type SubtopicCompetency = typeof subtopicCompetencies.$inferSelect;
export type InsertSubtopicCompetency = z.infer<typeof insertSubtopicCompetencySchema>;

export const insertTopicCompetencySchema = createInsertSchema(topicCompetencies).omit({ id: true });
export type TopicCompetency = typeof topicCompetencies.$inferSelect;
export type InsertTopicCompetency = z.infer<typeof insertTopicCompetencySchema>;

export const insertPaperTopicMappingSchema = createInsertSchema(paperTopicMappings).omit({ id: true });
export type PaperTopicMapping = typeof paperTopicMappings.$inferSelect;
export type InsertPaperTopicMapping = z.infer<typeof insertPaperTopicMappingSchema>;

export const insertSubtopicPaperMappingSchema = createInsertSchema(subtopicPaperMappings).omit({ id: true });
export type SubtopicPaperMapping = typeof subtopicPaperMappings.$inferSelect;
export type InsertSubtopicPaperMapping = z.infer<typeof insertSubtopicPaperMappingSchema>;

export const insertTopicEmbeddingSchema = createInsertSchema(topicEmbeddings, {
  embedding: z.array(z.number()),
}).omit({ id: true, embeddedAt: true });
export type TopicEmbedding = typeof topicEmbeddings.$inferSelect;
export type InsertTopicEmbedding = z.infer<typeof insertTopicEmbeddingSchema>;

export const insertAssessmentObjectiveSchema = createInsertSchema(assessmentObjectives).omit({ id: true });
export type AssessmentObjective = typeof assessmentObjectives.$inferSelect;
export type InsertAssessmentObjective = z.infer<typeof insertAssessmentObjectiveSchema>;

export const insertAssessmentObjectiveCompetencySchema = createInsertSchema(assessmentObjectiveCompetencies).omit({ id: true });
export type AssessmentObjectiveCompetency = typeof assessmentObjectiveCompetencies.$inferSelect;
export type InsertAssessmentObjectiveCompetency = z.infer<typeof insertAssessmentObjectiveCompetencySchema>;

export const insertAiUsageLogSchema = createInsertSchema(aiUsageLogs).omit({ id: true, createdAt: true });
export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type InsertAiUsageLog = z.infer<typeof insertAiUsageLogSchema>;

export const insertRevisionPlanSchema = createInsertSchema(revisionPlans).omit({ id: true, generatedAt: true, updatedAt: true });
export type RevisionPlan = typeof revisionPlans.$inferSelect;
export type InsertRevisionPlan = z.infer<typeof insertRevisionPlanSchema>;

export const insertCommandWordPerformanceSchema = createInsertSchema(commandWordPerformance).omit({ id: true, updatedAt: true });
export type CommandWordPerformance = typeof commandWordPerformance.$inferSelect;
export type InsertCommandWordPerformance = z.infer<typeof insertCommandWordPerformanceSchema>;

export const insertAnswerDiagnosisSchema = createInsertSchema(answerDiagnoses).omit({ id: true, createdAt: true });
export type AnswerDiagnosis = typeof answerDiagnoses.$inferSelect;
export type InsertAnswerDiagnosis = z.infer<typeof insertAnswerDiagnosisSchema>;

export const insertStudentMisconceptionSchema = createInsertSchema(studentMisconceptions).omit({ id: true, firstSeenAt: true, lastSeenAt: true, updatedAt: true });
export type StudentMisconception = typeof studentMisconceptions.$inferSelect;
export type InsertStudentMisconception = z.infer<typeof insertStudentMisconceptionSchema>;

// Legacy schemas retained for compatibility with older admin flows and tests.
// The current app stores quiz content in soma_* tables.
export const insertQuizSchema = z.object({
  title: z.string().min(1),
  timeLimitMinutes: z.number().int().positive(),
  dueDate: z.coerce.date(),
});

export const insertQuestionSchema = z.object({
  quizId: z.number().int().positive(),
  promptText: z.string().min(1),
  imageUrl: z.string().nullable().optional(),
  options: z.array(z.string()).length(4),
  correctAnswer: z.string().min(1),
  marksWorth: z.number().int().positive().default(1),
});

export const insertStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

export const insertSubmissionSchema = z.object({
  studentId: z.number().int().positive(),
  quizId: z.number().int().positive(),
  answers: z.record(z.coerce.number().int()),
  score: z.number().int().nonnegative(),
  startedAt: z.date().optional(),
  submittedAt: z.date().optional(),
});

export const questionUploadSchema = z.array(z.object({
  prompt_text: z.string().min(1),
  image_url: z.string().nullable().optional(),
  options: z.array(z.string().min(1)).length(4),
  correct_answer: z.string().min(1),
  marks_worth: z.number().int().positive().optional().default(1),
}));

export type InsertQuiz = z.infer<typeof insertQuizSchema>;
export type InsertQuestion = z.infer<typeof insertQuestionSchema>;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
