import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, json, jsonb, serial, uuid, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const somaUsers = pgTable("soma_users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: text("role").notNull().default("student"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const somaQuizzes = pgTable("soma_quizzes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  topic: text("topic").notNull(),
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
  "English",
  "Computer Science",
  "Accounting",
  "Geography",
  "History",
] as const;

export const insertSomaUserSchema = createInsertSchema(somaUsers).omit({ createdAt: true });
export const insertSomaQuizSchema = createInsertSchema(somaQuizzes).omit({ id: true, createdAt: true });
export const insertSomaQuestionSchema = createInsertSchema(somaQuestions).omit({ id: true });
export const insertSomaReportSchema = createInsertSchema(somaReports).omit({ id: true, createdAt: true });

export type SomaUser = typeof somaUsers.$inferSelect;
export type InsertSomaUser = z.infer<typeof insertSomaUserSchema>;
export type SomaQuiz = typeof somaQuizzes.$inferSelect;
export type InsertSomaQuiz = z.infer<typeof insertSomaQuizSchema>;
export type SomaQuestion = typeof somaQuestions.$inferSelect;
export type InsertSomaQuestion = z.infer<typeof insertSomaQuestionSchema>;
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

// Legacy schemas retained for compatibility with older admin flows and tests.
// The current app stores quiz content in soma_* tables, but these schemas are
// still used for payload validation in shared utilities and historical routes.
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
