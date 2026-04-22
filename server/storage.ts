import {
  type SomaQuiz, type InsertSomaQuiz,
  type SomaQuestion, type InsertSomaQuestion,
  type SomaUser, type InsertSomaUser,
  type SomaReport, type InsertSomaReport,
  type TutorStudent, type InsertTutorStudent,
  type QuizAssignment, type InsertQuizAssignment,
  type TutorComment, type InsertTutorComment,
  type SyllabusDocument, type InsertSyllabusDocument,
  type SyllabusChunk, type InsertSyllabusChunk,
  type StudentSubject, type InsertStudentSubject,
  type TutorNotification, type InsertTutorNotification,
  type StudentTopicMastery,
  type SuggestedAssessment, type InsertSuggestedAssessment,
  type ExaminerMisconception, type InsertExaminerMisconception,
  type SyllabusTopicInventoryItem, type InsertSyllabusTopicInventoryItem,
  type StudentNotification, type InsertStudentNotification,
  type FlaggedQuestion, type InsertFlaggedQuestion,
  somaQuizzes, somaQuestions, somaUsers, somaReports,
  tutorStudents, quizAssignments, tutorComments, syllabusDocuments, syllabusChunks,
  studentSubjects, tutorNotifications, studentTopicMastery, suggestedAssessments,
  examinerMisconceptions, syllabusTopicInventory,
  studentNotifications, flaggedQuestions,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, ne, inArray, or, isNull, sql, count, avg, sum, desc } from "drizzle-orm";


// Spaced repetition intervals: 7 days → 30 days → 90 days
const REVIEW_INTERVALS = [7, 30, 90];

function computeNextReviewDate(currentReviewAt: Date | null, attempts: number): Date {
  const intervalIndex = Math.min(attempts, REVIEW_INTERVALS.length - 1);
  const days = REVIEW_INTERVALS[intervalIndex];
  return new Date(Date.now() + days * 86400000);
}

type SomaQuizBundleQuestionInput = {
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  marks?: number;
};

export interface TutorDashboardSummary {
  tutorId: string;
  tutorEmail: string;
  tutorName: string | null;
  adoptedStudentsCount: number;
  assessmentsCompletedCount: number;
  averageStudentGrade: number | null;
  subjects: string[];
  lastLoginAt: string | null;
}

export interface TutorDashboardDetail extends TutorDashboardSummary {
  students: Array<{ id: string; name: string | null; email: string }>;
  recentAssessments: Array<{
    reportId: number;
    studentName: string;
    quizId: number;
    quizTitle: string;
    subject: string | null;
    scorePercent: number;
    completedAt: string | null;
    createdAt: string;
  }>;
}

export interface IStorage {
  upsertSomaUser(user: InsertSomaUser): Promise<SomaUser>;

  createSomaQuiz(quiz: InsertSomaQuiz): Promise<SomaQuiz>;
  createSomaQuizBundle(input: {
    quiz: InsertSomaQuiz;
    questions: SomaQuizBundleQuestionInput[];
    assignedStudentIds?: string[];
  }): Promise<{ quiz: SomaQuiz; questions: SomaQuestion[]; assignments: QuizAssignment[] }>;
  getSomaQuizzes(): Promise<SomaQuiz[]>;
  getSomaQuiz(id: number): Promise<SomaQuiz | undefined>;
  updateSomaQuiz(id: number, data: Partial<InsertSomaQuiz>): Promise<SomaQuiz | undefined>;
  createSomaQuestions(questionList: InsertSomaQuestion[]): Promise<SomaQuestion[]>;
  getSomaQuestionsByQuizId(quizId: number): Promise<SomaQuestion[]>;
  getSomaQuestionTotalsByQuizIds(quizIds: number[]): Promise<Record<number, number>>;
  deleteSomaQuestion(id: number): Promise<void>;
  deleteSomaQuestionsByQuizId(quizId: number): Promise<void>;
  /** Atomically replace all questions for a quiz inside a DB transaction. */
  publishSomaQuestionsTransactional(quizId: number, questionList: InsertSomaQuestion[]): Promise<SomaQuestion[]>;
  getSomaReportsByStudentId(studentId: string): Promise<(SomaReport & { quiz: SomaQuiz })[]>;
  createSomaReport(report: InsertSomaReport): Promise<SomaReport>;
  updateSomaReport(reportId: number, data: Partial<{ status: string; aiFeedbackHtml: string | null }>): Promise<SomaReport | undefined>;
  checkSomaSubmission(quizId: number, studentId: string): Promise<boolean>;
  getSomaReportById(reportId: number): Promise<(SomaReport & { quiz: SomaQuiz }) | undefined>;
  getSomaReportsByQuizId(quizId: number): Promise<(SomaReport & { quiz: SomaQuiz })[]>;

  getSomaUserByEmail(email: string): Promise<SomaUser | undefined>;
  getSomaUserById(id: string): Promise<SomaUser | undefined>;
  getAllStudents(): Promise<SomaUser[]>;
  adoptStudent(tutorId: string, studentId: string): Promise<TutorStudent>;
  removeAdoptedStudent(tutorId: string, studentId: string): Promise<void>;
  getAdoptedStudents(tutorId: string): Promise<SomaUser[]>;
  getAvailableStudents(tutorId: string): Promise<SomaUser[]>;

  createQuizAssignments(quizId: number, studentIds: string[], dueDate?: Date | null): Promise<QuizAssignment[]>;
  getQuizAssignmentsForStudent(studentId: string): Promise<(QuizAssignment & { quiz: SomaQuiz })[]>;
  getQuizAssignmentsForQuiz(quizId: number): Promise<(QuizAssignment & { student: SomaUser })[]>;
  getTutorAssessmentsOverview(tutorId: string): Promise<Array<{
    quizId: number;
    assignedStudentIds: string[];
    latestSubmissionAt: string | null;
  }>>;
  /**
   * For each studentId, the set of subjects the student has been assigned a quiz in
   * (via quiz_assignments → soma_quizzes.subject). Subjects are normalized to the
   * original casing; the returned `Set` membership is case-insensitive via lowercase keys.
   * A tutor should only see cohort/student performance for these subjects.
   */
  getAssignedSubjectsForStudents(studentIds: string[]): Promise<Record<string, string[]>>;
  updateQuizAssignmentStatus(quizId: number, studentId: string, status: string): Promise<void>;
  deleteQuizAssignment(quizId: number, studentId: string): Promise<void>;
  extendQuizAssignmentDeadlines(quizId: number, hours: number): Promise<number>;
  updateQuizAssignmentsDueDate(quizId: number, dueDate: Date | null): Promise<number>;

  getSomaQuizzesByAuthor(authorId: string): Promise<SomaQuiz[]>;

  addTutorComment(comment: InsertTutorComment): Promise<TutorComment>;
  getTutorComments(tutorId: string, studentId: string): Promise<TutorComment[]>;

  getDashboardStatsForTutor(tutorId: string): Promise<{
    totalStudents: number;
    totalQuizzes: number;
    cohortAverages: { subject: string; average: number; count: number }[];
    recentSubmissions: { reportId: number; studentId: string; studentName: string; score: number; quizTitle: string; subject: string | null; createdAt: string; startedAt: string | null; completedAt: string | null }[];
    pendingAssignments: { assignmentId: number; quizId: number; quizTitle: string; subject: string | null; studentId: string; studentName: string; dueDate: string | null; createdAt: string }[];
    studentInsights: { studentId: string; studentName: string; assigned: number; completed: number; awaiting: number; trend: "improving" | "declining" | "stable"; weakTopics: string[] }[];
  }>;

  getAllSomaUsers(): Promise<SomaUser[]>;
  deleteSomaUser(userId: string): Promise<void>;
  deleteSomaQuiz(quizId: number): Promise<void>;
  getAllSomaQuizzes(): Promise<SomaQuiz[]>;
  touchUserLastLogin(userId: string): Promise<void>;
  getTutorDashboardSummaries(): Promise<TutorDashboardSummary[]>;
  getTutorDashboardDetail(tutorId: string): Promise<TutorDashboardDetail | undefined>;

  logPasswordResetRequest(email: string): Promise<void>;
  createSyllabusDocument(document: InsertSyllabusDocument, chunks: Omit<InsertSyllabusChunk, "documentId">[]): Promise<{ document: SyllabusDocument; chunks: SyllabusChunk[] }>;
  listSyllabusDocuments(tutorId?: string): Promise<SyllabusDocument[]>;
  listCanonicalSyllabi(filter?: { subject?: string; level?: string; board?: string }): Promise<SyllabusDocument[]>;
  getSyllabusDocumentBySelection(selection: { board: string; level: string; syllabusCode: string; tutorId?: string }): Promise<(SyllabusDocument & { chunks: SyllabusChunk[] }) | undefined>;
  getSyllabusDocumentByHash(contentHash: string): Promise<SyllabusDocument | undefined>;
  listStudentSubjects(studentId: string): Promise<StudentSubject[]>;
  addStudentSubject(subject: InsertStudentSubject): Promise<StudentSubject>;
  updateStudentSubject(id: number, studentId: string, data: Partial<InsertStudentSubject>): Promise<StudentSubject | undefined>;
  upsertStudentTopicMastery(input: {
    studentId: string;
    subject: string;
    topic: string;
    subtopic?: string | null;
    understandingPercent: number;
    masteryAchieved?: boolean;
    covered?: boolean;
    tested?: boolean;
    totalQuestions?: number;
    correctQuestions?: number;
  }): Promise<StudentTopicMastery>;
  listStudentTopicMastery(studentId: string): Promise<StudentTopicMastery[]>;
  createTutorNotification(notification: InsertTutorNotification): Promise<TutorNotification>;
  listTutorNotifications(tutorId: string): Promise<TutorNotification[]>;
  markTutorNotificationRead(notificationId: number, tutorId: string): Promise<TutorNotification | undefined>;
  createSuggestedAssessment(suggestion: InsertSuggestedAssessment): Promise<SuggestedAssessment>;
  listSuggestedAssessments(tutorId: string, studentId: string): Promise<SuggestedAssessment[]>;
  updateSuggestedAssessmentStatus(id: number, tutorId: string, status: string, generatedQuizId?: number): Promise<SuggestedAssessment | undefined>;

  deleteStudentSubject(id: number, studentId: string): Promise<void>;

  // Examiner misconception storage
  createExaminerMisconceptions(items: InsertExaminerMisconception[]): Promise<ExaminerMisconception[]>;
  listExaminerMisconceptions(filter: { board?: string; syllabusCode?: string; topic?: string }): Promise<ExaminerMisconception[]>;

  // Syllabus topic inventory
  createSyllabusTopicInventory(items: InsertSyllabusTopicInventoryItem[]): Promise<SyllabusTopicInventoryItem[]>;
  listSyllabusTopicInventory(filter: { board?: string; syllabusCode?: string; subject?: string }): Promise<SyllabusTopicInventoryItem[]>;

  // Student-facing notifications
  createStudentNotification(notification: InsertStudentNotification): Promise<StudentNotification>;
  listStudentNotifications(studentId: string, options?: { limit?: number }): Promise<StudentNotification[]>;
  markStudentNotificationRead(notificationId: number, studentId: string): Promise<StudentNotification | undefined>;
  markAllStudentNotificationsRead(studentId: string): Promise<number>;

  // Question-level flag raised by a student during a quiz
  flagQuestion(input: InsertFlaggedQuestion): Promise<FlaggedQuestion>;
  listFlaggedQuestionsForTutor(tutorId: string, filter?: { quizId?: number; studentId?: string; unresolvedOnly?: boolean }): Promise<Array<FlaggedQuestion & { question: SomaQuestion; quiz: SomaQuiz; student: { id: string; displayName: string | null; email: string } }>>;
  listFlaggedQuestionsForStudent(studentId: string): Promise<Array<FlaggedQuestion & { question: SomaQuestion; quiz: SomaQuiz }>>;
  resolveFlaggedQuestion(flagId: number, tutorId: string): Promise<FlaggedQuestion | undefined>;
  unflagQuestion(studentId: string, questionId: number): Promise<void>;

}

class DatabaseStorage implements IStorage {
  constructor(private readonly database: NonNullable<typeof db>) {}

  async createSomaQuiz(quiz: InsertSomaQuiz): Promise<SomaQuiz> {
    const [result] = await this.database.insert(somaQuizzes).values(quiz).returning();
    return result;
  }

  async createSomaQuizBundle(input: {
    quiz: InsertSomaQuiz;
    questions: SomaQuizBundleQuestionInput[];
    assignedStudentIds?: string[];
  }): Promise<{ quiz: SomaQuiz; questions: SomaQuestion[]; assignments: QuizAssignment[] }> {
    return this.database.transaction(async (tx) => {
      const [quiz] = await tx.insert(somaQuizzes).values(input.quiz).returning();
      const questions = input.questions.length === 0
        ? []
        : await tx.insert(somaQuestions).values(
          input.questions.map((q) => ({ ...q, quizId: quiz.id }))
        ).returning();

      const uniqueStudentIds = Array.from(new Set(input.assignedStudentIds ?? []));
      const assignments = uniqueStudentIds.length === 0
        ? []
        : await tx.insert(quizAssignments).values(
          uniqueStudentIds.map((studentId) => ({ quizId: quiz.id, studentId, status: "pending" }))
        ).onConflictDoNothing().returning();

      return { quiz, questions, assignments };
    });
  }

  async getSomaQuizzes(): Promise<SomaQuiz[]> {
    return this.database.select().from(somaQuizzes).orderBy(somaQuizzes.createdAt);
  }

  async getSomaQuiz(id: number): Promise<SomaQuiz | undefined> {
    const [result] = await this.database.select().from(somaQuizzes).where(eq(somaQuizzes.id, id));
    return result;
  }

  async updateSomaQuiz(id: number, data: Partial<InsertSomaQuiz>): Promise<SomaQuiz | undefined> {
    const [result] = await this.database.update(somaQuizzes).set(data).where(eq(somaQuizzes.id, id)).returning();
    return result;
  }

  async createSomaQuestions(questionList: InsertSomaQuestion[]): Promise<SomaQuestion[]> {
    if (questionList.length === 0) return [];
    const normalized = questionList.map((q) => ({
      quizId: q.quizId,
      stem: q.stem,
      options: Array.isArray(q.options) ? [...q.options] as string[] : [],
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      marks: q.marks ?? 1,
      questionType: q.questionType ?? "multiple_choice",
      graphSpec: (q.graphSpec ?? null) as any,
      topicTag: q.topicTag ?? null,
      subtopicTag: q.subtopicTag ?? null,
      difficultyTag: q.difficultyTag ?? null,
    }));
    return this.database.insert(somaQuestions).values(normalized).returning();
  }

  async getSomaQuestionsByQuizId(quizId: number): Promise<SomaQuestion[]> {
    return this.database.select().from(somaQuestions).where(eq(somaQuestions.quizId, quizId));
  }

  async createSyllabusDocument(document: InsertSyllabusDocument, chunks: Omit<InsertSyllabusChunk, "documentId">[]): Promise<{ document: SyllabusDocument; chunks: SyllabusChunk[] }> {
    return this.database.transaction(async (tx) => {
      const [createdDocument] = await tx.insert(syllabusDocuments).values(document).returning();
      const createdChunks = chunks.length === 0 ? [] : await tx.insert(syllabusChunks).values(chunks.map((chunk) => ({ ...chunk, documentId: createdDocument.id }))).returning();
      return { document: createdDocument, chunks: createdChunks };
    });
  }

  async listSyllabusDocuments(tutorId?: string): Promise<SyllabusDocument[]> {
    if (tutorId) {
      return this.database.select().from(syllabusDocuments).where(or(eq(syllabusDocuments.tutorId, tutorId), isNull(syllabusDocuments.tutorId))).orderBy(syllabusDocuments.uploadedAt);
    }
    return this.database.select().from(syllabusDocuments).orderBy(syllabusDocuments.uploadedAt);
  }

  async listCanonicalSyllabi(filter: { subject?: string; level?: string; board?: string } = {}): Promise<SyllabusDocument[]> {
    // Case-insensitive matching on subject/level/board: the builder dropdown
    // sends `STANDARDIZED_SUBJECTS` values like "Mathematics" / "A Level",
    // while the curriculum ingest script stores tokens lowercased ("mathematics")
    // straight from the filename. A naive `eq()` here returns an empty list
    // and silently empties the syllabus picker.
    const conditions = [
      isNull(syllabusDocuments.tutorId),
      eq(syllabusDocuments.documentType, "syllabus"),
    ];
    if (filter.board) conditions.push(sql`lower(${syllabusDocuments.board}) = lower(${filter.board})`);
    if (filter.level) conditions.push(sql`lower(${syllabusDocuments.level}) = lower(${filter.level})`);
    if (filter.subject) conditions.push(sql`lower(${syllabusDocuments.subject}) = lower(${filter.subject})`);
    return this.database.select().from(syllabusDocuments).where(and(...conditions)).orderBy(syllabusDocuments.subject, syllabusDocuments.syllabusCode);
  }

  async getSyllabusDocumentBySelection(selection: { board: string; level: string; syllabusCode: string; tutorId?: string }): Promise<(SyllabusDocument & { chunks: SyllabusChunk[] }) | undefined> {
    const conditions = [eq(syllabusDocuments.board, selection.board), eq(syllabusDocuments.level, selection.level), eq(syllabusDocuments.syllabusCode, selection.syllabusCode)];
    if (selection.tutorId) conditions.push(or(eq(syllabusDocuments.tutorId, selection.tutorId), isNull(syllabusDocuments.tutorId)) as any);
    const [document] = await this.database.select().from(syllabusDocuments).where(and(...conditions as any));
    if (!document) return undefined;
    const chunks = await this.database.select().from(syllabusChunks).where(eq(syllabusChunks.documentId, document.id));
    return { ...document, chunks };
  }

  async getSyllabusDocumentByHash(contentHash: string): Promise<SyllabusDocument | undefined> {
    const [doc] = await this.database.select().from(syllabusDocuments).where(eq(syllabusDocuments.contentHash, contentHash));
    return doc;
  }

  async listStudentSubjects(studentId: string): Promise<StudentSubject[]> {
    return this.database.select().from(studentSubjects).where(eq(studentSubjects.studentId, studentId)).orderBy(studentSubjects.createdAt);
  }

  async addStudentSubject(subject: InsertStudentSubject): Promise<StudentSubject> {
    const [row] = await this.database.insert(studentSubjects).values(subject).returning();
    return row;
  }

  async updateStudentSubject(id: number, studentId: string, data: Partial<InsertStudentSubject>): Promise<StudentSubject | undefined> {
    const [row] = await this.database
      .update(studentSubjects)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(studentSubjects.id, id), eq(studentSubjects.studentId, studentId)))
      .returning();
    return row;
  }

  async upsertStudentTopicMastery(input: {
    studentId: string;
    subject: string;
    topic: string;
    subtopic?: string | null;
    understandingPercent: number;
    masteryAchieved?: boolean;
    covered?: boolean;
    tested?: boolean;
    totalQuestions?: number;
    correctQuestions?: number;
  }): Promise<StudentTopicMastery> {
    const clampedPercent = Math.max(0, Math.min(100, Math.round(input.understandingPercent)));
    const totalQ = input.totalQuestions ?? 0;
    const confidenceLevel = totalQ >= 10 ? "high" : totalQ >= 5 ? "medium" : "low";
    const mastered = input.masteryAchieved ?? (clampedPercent >= 75 && totalQ >= 5);

    // Spaced repetition: schedule review at 7 days after mastery
    // On subsequent reviews: 7 → 30 → 90 days
    const nextReviewAt = mastered ? computeNextReviewDate(null, 0) : null;

    const payload = {
      studentId: input.studentId,
      subject: input.subject,
      topic: input.topic,
      subtopic: input.subtopic ?? null,
      understandingPercent: clampedPercent,
      masteryAchieved: mastered,
      covered: Boolean(input.covered),
      tested: Boolean(input.tested),
      attempts: 1,
      totalQuestions: totalQ,
      correctQuestions: input.correctQuestions ?? 0,
      confidenceLevel,
      lastTestedAt: new Date(),
      nextReviewAt,
      updatedAt: new Date(),
    };
    const [row] = await this.database
      .insert(studentTopicMastery)
      .values(payload)
      .onConflictDoUpdate({
        target: [studentTopicMastery.studentId, studentTopicMastery.subject, studentTopicMastery.topic, studentTopicMastery.subtopic],
        set: {
          understandingPercent: payload.understandingPercent,
          masteryAchieved: payload.masteryAchieved,
          covered: payload.covered,
          tested: payload.tested,
          attempts: sql`${studentTopicMastery.attempts} + 1`,
          totalQuestions: sql`${studentTopicMastery.totalQuestions} + ${totalQ}`,
          correctQuestions: sql`${studentTopicMastery.correctQuestions} + ${input.correctQuestions ?? 0}`,
          confidenceLevel,
          lastTestedAt: new Date(),
          nextReviewAt: mastered
            ? sql`CASE
                WHEN ${studentTopicMastery.nextReviewAt} IS NULL THEN ${new Date(Date.now() + 7 * 86400000)}::timestamp
                WHEN ${studentTopicMastery.attempts} <= 2 THEN ${new Date(Date.now() + 30 * 86400000)}::timestamp
                ELSE ${new Date(Date.now() + 90 * 86400000)}::timestamp
              END`
            : null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async listStudentTopicMastery(studentId: string): Promise<StudentTopicMastery[]> {
    return this.database.select().from(studentTopicMastery).where(eq(studentTopicMastery.studentId, studentId)).orderBy(studentTopicMastery.updatedAt);
  }

  async createTutorNotification(notification: InsertTutorNotification): Promise<TutorNotification> {
    const [row] = await this.database.insert(tutorNotifications).values(notification).returning();
    return row;
  }

  async listTutorNotifications(tutorId: string): Promise<TutorNotification[]> {
    return this.database.select().from(tutorNotifications).where(eq(tutorNotifications.tutorId, tutorId)).orderBy(desc(tutorNotifications.createdAt));
  }

  async markTutorNotificationRead(notificationId: number, tutorId: string): Promise<TutorNotification | undefined> {
    const [row] = await this.database
      .update(tutorNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(tutorNotifications.id, notificationId), eq(tutorNotifications.tutorId, tutorId)))
      .returning();
    return row;
  }

  async createSuggestedAssessment(suggestion: InsertSuggestedAssessment): Promise<SuggestedAssessment> {
    const [row] = await this.database.insert(suggestedAssessments).values(suggestion).returning();
    return row;
  }

  async listSuggestedAssessments(tutorId: string, studentId: string): Promise<SuggestedAssessment[]> {
    return this.database
      .select()
      .from(suggestedAssessments)
      .where(and(eq(suggestedAssessments.tutorId, tutorId), eq(suggestedAssessments.studentId, studentId)))
      .orderBy(desc(suggestedAssessments.createdAt));
  }

  async updateSuggestedAssessmentStatus(id: number, tutorId: string, status: string, generatedQuizId?: number): Promise<SuggestedAssessment | undefined> {
    const [row] = await this.database
      .update(suggestedAssessments)
      .set({ status, generatedQuizId: generatedQuizId ?? null })
      .where(and(eq(suggestedAssessments.id, id), eq(suggestedAssessments.tutorId, tutorId)))
      .returning();
    return row;
  }

  async deleteStudentSubject(id: number, studentId: string): Promise<void> {
    await this.database
      .delete(studentSubjects)
      .where(and(eq(studentSubjects.id, id), eq(studentSubjects.studentId, studentId)));
  }

  async createExaminerMisconceptions(items: InsertExaminerMisconception[]): Promise<ExaminerMisconception[]> {
    if (items.length === 0) return [];
    return this.database.insert(examinerMisconceptions).values(items).returning();
  }

  async listExaminerMisconceptions(filter: { board?: string; syllabusCode?: string; topic?: string }): Promise<ExaminerMisconception[]> {
    const conditions = [];
    if (filter.board) conditions.push(eq(examinerMisconceptions.board, filter.board));
    if (filter.syllabusCode) conditions.push(eq(examinerMisconceptions.syllabusCode, filter.syllabusCode));
    if (filter.topic) conditions.push(eq(examinerMisconceptions.topic, filter.topic));
    if (conditions.length === 0) return this.database.select().from(examinerMisconceptions);
    return this.database.select().from(examinerMisconceptions).where(and(...conditions));
  }

  async createSyllabusTopicInventory(items: InsertSyllabusTopicInventoryItem[]): Promise<SyllabusTopicInventoryItem[]> {
    if (items.length === 0) return [];
    return this.database.insert(syllabusTopicInventory).values(items).returning();
  }

  async listSyllabusTopicInventory(filter: { board?: string; syllabusCode?: string; subject?: string }): Promise<SyllabusTopicInventoryItem[]> {
    // Case-insensitive matching — see note on listCanonicalSyllabi above. The
    // builder forwards the syllabus doc's stored subject verbatim, but a
    // future change to either side could re-introduce the same case mismatch
    // and silently empty the topic picker.
    const conditions = [];
    if (filter.board) conditions.push(sql`lower(${syllabusTopicInventory.board}) = lower(${filter.board})`);
    if (filter.syllabusCode) conditions.push(sql`lower(${syllabusTopicInventory.syllabusCode}) = lower(${filter.syllabusCode})`);
    if (filter.subject) conditions.push(sql`lower(${syllabusTopicInventory.subject}) = lower(${filter.subject})`);
    if (conditions.length === 0) return this.database.select().from(syllabusTopicInventory);
    return this.database.select().from(syllabusTopicInventory).where(and(...conditions));
  }

  async createStudentNotification(notification: InsertStudentNotification): Promise<StudentNotification> {
    const [row] = await this.database.insert(studentNotifications).values(notification).returning();
    return row;
  }

  async listStudentNotifications(studentId: string, options: { limit?: number } = {}): Promise<StudentNotification[]> {
    const limit = options.limit ?? 25;
    return this.database
      .select()
      .from(studentNotifications)
      .where(eq(studentNotifications.studentId, studentId))
      .orderBy(desc(studentNotifications.createdAt))
      .limit(limit);
  }

  async markStudentNotificationRead(notificationId: number, studentId: string): Promise<StudentNotification | undefined> {
    const [row] = await this.database
      .update(studentNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(studentNotifications.id, notificationId), eq(studentNotifications.studentId, studentId)))
      .returning();
    return row;
  }

  async markAllStudentNotificationsRead(studentId: string): Promise<number> {
    const rows = await this.database
      .update(studentNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(studentNotifications.studentId, studentId), isNull(studentNotifications.readAt)))
      .returning();
    return rows.length;
  }

  async flagQuestion(input: InsertFlaggedQuestion): Promise<FlaggedQuestion> {
    const [row] = await this.database
      .insert(flaggedQuestions)
      .values(input)
      .onConflictDoUpdate({
        target: [flaggedQuestions.studentId, flaggedQuestions.questionId],
        set: {
          quizId: input.quizId,
          reportId: input.reportId ?? null,
          reason: input.reason ?? null,
          resolvedAt: null,
          tutorViewedAt: null,
          createdAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async listFlaggedQuestionsForTutor(
    tutorId: string,
    filter: { quizId?: number; studentId?: string; unresolvedOnly?: boolean } = {},
  ): Promise<Array<FlaggedQuestion & { question: SomaQuestion; quiz: SomaQuiz; student: { id: string; displayName: string | null; email: string } }>> {
    const conditions = [eq(somaQuizzes.authorId, tutorId)];
    if (filter.quizId !== undefined) conditions.push(eq(flaggedQuestions.quizId, filter.quizId));
    if (filter.studentId) conditions.push(eq(flaggedQuestions.studentId, filter.studentId));
    if (filter.unresolvedOnly) conditions.push(isNull(flaggedQuestions.resolvedAt));
    const rows = await this.database
      .select({ flag: flaggedQuestions, question: somaQuestions, quiz: somaQuizzes, student: somaUsers })
      .from(flaggedQuestions)
      .innerJoin(somaQuestions, eq(flaggedQuestions.questionId, somaQuestions.id))
      .innerJoin(somaQuizzes, eq(flaggedQuestions.quizId, somaQuizzes.id))
      .innerJoin(somaUsers, eq(flaggedQuestions.studentId, somaUsers.id))
      .where(and(...conditions))
      .orderBy(desc(flaggedQuestions.createdAt));
    return rows.map((r) => ({
      ...r.flag,
      question: r.question,
      quiz: r.quiz,
      student: { id: r.student.id, displayName: r.student.displayName, email: r.student.email },
    }));
  }

  async listFlaggedQuestionsForStudent(studentId: string): Promise<Array<FlaggedQuestion & { question: SomaQuestion; quiz: SomaQuiz }>> {
    const rows = await this.database
      .select({ flag: flaggedQuestions, question: somaQuestions, quiz: somaQuizzes })
      .from(flaggedQuestions)
      .innerJoin(somaQuestions, eq(flaggedQuestions.questionId, somaQuestions.id))
      .innerJoin(somaQuizzes, eq(flaggedQuestions.quizId, somaQuizzes.id))
      .where(eq(flaggedQuestions.studentId, studentId))
      .orderBy(desc(flaggedQuestions.createdAt));
    return rows.map((r) => ({ ...r.flag, question: r.question, quiz: r.quiz }));
  }

  async resolveFlaggedQuestion(flagId: number, tutorId: string): Promise<FlaggedQuestion | undefined> {
    const [target] = await this.database
      .select({ flag: flaggedQuestions })
      .from(flaggedQuestions)
      .innerJoin(somaQuizzes, eq(flaggedQuestions.quizId, somaQuizzes.id))
      .where(and(eq(flaggedQuestions.id, flagId), eq(somaQuizzes.authorId, tutorId)));
    if (!target) return undefined;
    const [row] = await this.database
      .update(flaggedQuestions)
      .set({ resolvedAt: new Date(), tutorViewedAt: new Date() })
      .where(eq(flaggedQuestions.id, flagId))
      .returning();
    return row;
  }

  async unflagQuestion(studentId: string, questionId: number): Promise<void> {
    await this.database
      .delete(flaggedQuestions)
      .where(and(eq(flaggedQuestions.studentId, studentId), eq(flaggedQuestions.questionId, questionId)));
  }

  async getSomaQuestionTotalsByQuizIds(quizIds: number[]): Promise<Record<number, number>> {
    if (quizIds.length === 0) return {};

    const rows = await this.database
      .select({
        quizId: somaQuestions.quizId,
        totalMarks: sql<number>`coalesce(sum(${somaQuestions.marks}), 0)::int`,
      })
      .from(somaQuestions)
      .where(inArray(somaQuestions.quizId, quizIds))
      .groupBy(somaQuestions.quizId);

    return rows.reduce<Record<number, number>>((acc, row) => {
      acc[row.quizId] = row.totalMarks;
      return acc;
    }, {});
  }

  async deleteSomaQuestion(id: number): Promise<void> {
    await this.database.delete(somaQuestions).where(eq(somaQuestions.id, id));
  }

  async deleteSomaQuestionsByQuizId(quizId: number): Promise<void> {
    await this.database.delete(somaQuestions).where(eq(somaQuestions.quizId, quizId));
  }

  async publishSomaQuestionsTransactional(quizId: number, questionList: InsertSomaQuestion[]): Promise<SomaQuestion[]> {
    return this.database.transaction(async (tx) => {
      await tx.delete(somaQuestions).where(eq(somaQuestions.quizId, quizId));
      if (questionList.length === 0) return [];
      const normalized = questionList.map((q) => ({
        quizId,
        stem: q.stem,
        options: Array.isArray(q.options) ? [...q.options] as string[] : [],
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        marks: q.marks ?? 1,
        questionType: q.questionType ?? "multiple_choice",
        graphSpec: (q.graphSpec ?? null) as any,
        topicTag: q.topicTag ?? null,
        subtopicTag: q.subtopicTag ?? null,
        difficultyTag: q.difficultyTag ?? null,
      }));
      return tx.insert(somaQuestions).values(normalized).returning();
    });
  }

  async upsertSomaUser(user: InsertSomaUser): Promise<SomaUser> {
    const [result] = await this.database
      .insert(somaUsers)
      .values(user)
      .onConflictDoUpdate({
        target: somaUsers.id,
        set: { email: user.email, displayName: user.displayName, role: user.role ?? "student" },
      })
      .returning();
    return result;
  }

  async getSomaReportsByStudentId(studentId: string): Promise<(SomaReport & { quiz: SomaQuiz })[]> {
    const rows = await this.database
      .select({ report: somaReports, quiz: somaQuizzes })
      .from(somaReports)
      .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
      .where(eq(somaReports.studentId, studentId));
    return rows.map((r) => ({ ...r.report, quiz: r.quiz }));
  }

  async createSomaReport(report: InsertSomaReport): Promise<SomaReport> {
    const [result] = await this.database.insert(somaReports).values(report).returning();
    return result;
  }

  async updateSomaReport(reportId: number, data: Partial<{ status: string; aiFeedbackHtml: string | null }>): Promise<SomaReport | undefined> {
    const [result] = await this.database.update(somaReports).set(data).where(eq(somaReports.id, reportId)).returning();
    return result;
  }

  async checkSomaSubmission(quizId: number, studentId: string): Promise<boolean> {
    const existing = await this.database.select().from(somaReports)
      .where(and(eq(somaReports.quizId, quizId), eq(somaReports.studentId, studentId)));
    return existing.length > 0;
  }

  async getSomaReportById(reportId: number): Promise<(SomaReport & { quiz: SomaQuiz }) | undefined> {
    const rows = await this.database
      .select({ report: somaReports, quiz: somaQuizzes })
      .from(somaReports)
      .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
      .where(eq(somaReports.id, reportId));
    if (rows.length === 0) return undefined;
    return { ...rows[0].report, quiz: rows[0].quiz };
  }

  async getSomaReportsByQuizId(quizId: number): Promise<(SomaReport & { quiz: SomaQuiz })[]> {
    const rows = await this.database
      .select({ report: somaReports, quiz: somaQuizzes })
      .from(somaReports)
      .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
      .where(eq(somaReports.quizId, quizId));
    return rows.map((r) => ({ ...r.report, quiz: r.quiz }));
  }

  async getSomaUserByEmail(email: string): Promise<SomaUser | undefined> {
    const [result] = await this.database.select().from(somaUsers).where(eq(somaUsers.email, email));
    return result;
  }

  async getSomaUserById(id: string): Promise<SomaUser | undefined> {
    const [result] = await this.database.select().from(somaUsers).where(eq(somaUsers.id, id));
    return result;
  }

  async getAllStudents(): Promise<SomaUser[]> {
    return this.database.select().from(somaUsers).where(eq(somaUsers.role, "student"));
  }

  async adoptStudent(tutorId: string, studentId: string): Promise<TutorStudent> {
    const [result] = await this.database
      .insert(tutorStudents)
      .values({ tutorId, studentId })
      .onConflictDoNothing()
      .returning();
    if (!result) {
      const [existing] = await this.database.select().from(tutorStudents)
        .where(and(eq(tutorStudents.tutorId, tutorId), eq(tutorStudents.studentId, studentId)));
      return existing;
    }
    return result;
  }

  async removeAdoptedStudent(tutorId: string, studentId: string): Promise<void> {
    await this.database.delete(tutorStudents)
      .where(and(eq(tutorStudents.tutorId, tutorId), eq(tutorStudents.studentId, studentId)));
  }

  async getAdoptedStudents(tutorId: string): Promise<SomaUser[]> {
    const rows = await this.database
      .select({ student: somaUsers })
      .from(tutorStudents)
      .innerJoin(somaUsers, eq(tutorStudents.studentId, somaUsers.id))
      .where(eq(tutorStudents.tutorId, tutorId));
    return rows.map((r) => r.student);
  }

  async getAvailableStudents(tutorId: string): Promise<SomaUser[]> {
    // Step 1: Fetch ALL adopted student IDs for this tutor
    const adopted = await this.getAdoptedStudents(tutorId);
    const adoptedIds = new Set(adopted.map((s) => s.id));

    // Step 2: Fetch ALL users where role = 'student' OR role IS NULL
    const allStudents = await this.database.select().from(somaUsers)
      .where(
        or(eq(somaUsers.role, "student"), isNull(somaUsers.role))
      );

    // Step 3: Filter in plain JS — this cannot fail regardless of adoptedIds size
    const available = allStudents.filter(
      (s) => s.id !== tutorId && !adoptedIds.has(s.id)
    );

    return available;
  }

  async createQuizAssignments(quizId: number, studentIds: string[], dueDate?: Date | null): Promise<QuizAssignment[]> {
    if (studentIds.length === 0) return [];
    const values = studentIds.map((studentId) => ({ quizId, studentId, status: "pending", dueDate: dueDate || null }));
    return this.database.insert(quizAssignments).values(values).onConflictDoNothing().returning();
  }

  async getQuizAssignmentsForStudent(studentId: string): Promise<(QuizAssignment & { quiz: SomaQuiz })[]> {
    const rows = await this.database
      .select({ assignment: quizAssignments, quiz: somaQuizzes })
      .from(quizAssignments)
      .innerJoin(somaQuizzes, eq(quizAssignments.quizId, somaQuizzes.id))
      .where(eq(quizAssignments.studentId, studentId));
    return rows.map((r) => ({ ...r.assignment, quiz: r.quiz }));
  }

  async getQuizAssignmentsForQuiz(quizId: number): Promise<(QuizAssignment & { student: SomaUser })[]> {
    const rows = await this.database
      .select({ assignment: quizAssignments, student: somaUsers })
      .from(quizAssignments)
      .innerJoin(somaUsers, eq(quizAssignments.studentId, somaUsers.id))
      .where(eq(quizAssignments.quizId, quizId));
    return rows.map((r) => ({ ...r.assignment, student: r.student }));
  }

  async getAssignedSubjectsForStudents(studentIds: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const id of studentIds) result[id] = [];
    if (studentIds.length === 0) return result;
    const rows = await this.database
      .selectDistinct({
        studentId: quizAssignments.studentId,
        subject: somaQuizzes.subject,
      })
      .from(quizAssignments)
      .innerJoin(somaQuizzes, eq(quizAssignments.quizId, somaQuizzes.id))
      .where(inArray(quizAssignments.studentId, studentIds));
    for (const row of rows) {
      const subject = (row.subject || "").trim();
      if (!subject) continue;
      const list = result[row.studentId] ?? (result[row.studentId] = []);
      if (!list.some((s) => s.toLowerCase() === subject.toLowerCase())) list.push(subject);
    }
    return result;
  }

  async updateQuizAssignmentStatus(quizId: number, studentId: string, status: string): Promise<void> {
    await this.database.update(quizAssignments)
      .set({ status })
      .where(and(eq(quizAssignments.quizId, quizId), eq(quizAssignments.studentId, studentId)));
  }

  async deleteQuizAssignment(quizId: number, studentId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.delete(somaReports)
        .where(and(eq(somaReports.quizId, quizId), eq(somaReports.studentId, studentId)));
      await tx.delete(quizAssignments)
        .where(and(eq(quizAssignments.quizId, quizId), eq(quizAssignments.studentId, studentId)));
    });
  }

  async extendQuizAssignmentDeadlines(quizId: number, hours: number): Promise<number> {
    const result = await this.database.update(quizAssignments)
      .set({ dueDate: sql`coalesce(${quizAssignments.dueDate}, now()) + interval '1 hour' * ${hours}` })
      .where(and(eq(quizAssignments.quizId, quizId), eq(quizAssignments.status, "pending")))
      .returning();
    return result.length;
  }

  async updateQuizAssignmentsDueDate(quizId: number, dueDate: Date | null): Promise<number> {
    const result = await this.database.update(quizAssignments)
      .set({ dueDate })
      .where(eq(quizAssignments.quizId, quizId))
      .returning();
    return result.length;
  }

  async getSomaQuizzesByAuthor(authorId: string): Promise<SomaQuiz[]> {
    return this.database.select().from(somaQuizzes)
      .where(eq(somaQuizzes.authorId, authorId))
      .orderBy(desc(somaQuizzes.createdAt));
  }

  async getTutorAssessmentsOverview(tutorId: string): Promise<Array<{
    quizId: number;
    assignedStudentIds: string[];
    latestSubmissionAt: string | null;
  }>> {
    const quizRows = await this.database
      .select({ id: somaQuizzes.id })
      .from(somaQuizzes)
      .where(eq(somaQuizzes.authorId, tutorId));
    const quizIds = quizRows.map((r) => r.id);
    if (quizIds.length === 0) return [];

    const assignmentRows = await this.database
      .select({ quizId: quizAssignments.quizId, studentId: quizAssignments.studentId })
      .from(quizAssignments)
      .where(inArray(quizAssignments.quizId, quizIds));

    const submissionRows = await this.database
      .select({
        quizId: somaReports.quizId,
        completedAt: somaReports.completedAt,
        createdAt: somaReports.createdAt,
      })
      .from(somaReports)
      .where(inArray(somaReports.quizId, quizIds));

    const studentMap = new Map<number, Set<string>>();
    for (const row of assignmentRows) {
      if (!studentMap.has(row.quizId)) studentMap.set(row.quizId, new Set());
      studentMap.get(row.quizId)!.add(row.studentId);
    }

    const latestMap = new Map<number, number>();
    for (const row of submissionRows) {
      const ts = (row.completedAt ?? row.createdAt) as Date | null;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      const prev = latestMap.get(row.quizId) ?? 0;
      if (t > prev) latestMap.set(row.quizId, t);
    }

    return quizIds.map((quizId) => ({
      quizId,
      assignedStudentIds: Array.from(studentMap.get(quizId) ?? []),
      latestSubmissionAt: latestMap.has(quizId) ? new Date(latestMap.get(quizId)!).toISOString() : null,
    }));
  }

  async addTutorComment(comment: InsertTutorComment): Promise<TutorComment> {
    const [result] = await this.database.insert(tutorComments).values(comment).returning();
    return result;
  }

  async getTutorComments(tutorId: string, studentId: string): Promise<TutorComment[]> {
    return this.database.select().from(tutorComments)
      .where(and(eq(tutorComments.tutorId, tutorId), eq(tutorComments.studentId, studentId)))
      .orderBy(tutorComments.createdAt);
  }

  async getDashboardStatsForTutor(tutorId: string) {
    const adoptedStudentRows = await this.database
      .select({ studentId: tutorStudents.studentId })
      .from(tutorStudents)
      .where(eq(tutorStudents.tutorId, tutorId));
    const adoptedIds = adoptedStudentRows.map((r) => r.studentId);
    const totalStudents = adoptedIds.length;

    if (totalStudents === 0) {
      const tutorQuizzes = await this.database.select({ id: somaQuizzes.id }).from(somaQuizzes);
      return { totalStudents: 0, totalQuizzes: tutorQuizzes.length, cohortAverages: [], recentSubmissions: [], pendingAssignments: [], studentInsights: [] };
    }

    // Subject visibility: a tutor only sees a student's performance for subjects
    // they've actually been assigned a quiz in. Build per-student and union sets.
    const assignedSubjectsByStudent = await this.getAssignedSubjectsForStudents(adoptedIds);
    const visibleSubjectKeys = (sid: string) =>
      new Set((assignedSubjectsByStudent[sid] || []).map((s) => s.toLowerCase()));
    const unionVisibleSubjects = new Set<string>();
    for (const sid of adoptedIds) {
      for (const s of assignedSubjectsByStudent[sid] || []) unionVisibleSubjects.add(s.toLowerCase());
    }

    const [quizCountResult, subjectAvgRows, recentRows, pendingRows] = await Promise.all([
      this.database.select({ cnt: sql<number>`count(*)::int` }).from(somaQuizzes),

      this.database
        .select({
          subject: sql<string>`coalesce(${somaQuizzes.subject}, 'General')`,
          totalScore: sql<number>`coalesce(sum(${somaReports.score}), 0)::int`,
          totalMax: sql<number>`coalesce(sum((select coalesce(sum(${somaQuestions.marks}), 0) from ${somaQuestions} where ${somaQuestions.quizId} = ${somaReports.quizId})), 0)::int`,
          cnt: sql<number>`count(*)::int`,
        })
        .from(somaReports)
        .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
        .where(inArray(somaReports.studentId, adoptedIds))
        .groupBy(sql`coalesce(${somaQuizzes.subject}, 'General')`),

      this.database
        .select({
          reportId: somaReports.id,
          studentId: somaReports.studentId,
          studentName: sql<string>`coalesce(${somaUsers.displayName}, ${somaReports.studentName}, ${somaUsers.email})`,
          score: somaReports.score,
          quizTitle: somaQuizzes.title,
          subject: somaQuizzes.subject,
          createdAt: somaReports.createdAt,
          startedAt: somaReports.startedAt,
          completedAt: somaReports.completedAt,
          maxScore: sql<number>`(select coalesce(sum(${somaQuestions.marks}), 0) from ${somaQuestions} where ${somaQuestions.quizId} = ${somaReports.quizId})::int`,
        })
        .from(somaReports)
        .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
        .leftJoin(somaUsers, eq(somaReports.studentId, somaUsers.id))
        .where(inArray(somaReports.studentId, adoptedIds))
        .orderBy(sql`${somaReports.createdAt} desc`)
        .limit(10),

      this.database
        .select({
          assignmentId: quizAssignments.id,
          quizId: quizAssignments.quizId,
          quizTitle: somaQuizzes.title,
          subject: somaQuizzes.subject,
          studentId: quizAssignments.studentId,
          studentName: sql<string>`coalesce(${somaUsers.displayName}, ${somaUsers.email})`,
          dueDate: quizAssignments.dueDate,
          assignedAt: quizAssignments.createdAt,
        })
        .from(quizAssignments)
        .innerJoin(somaQuizzes, eq(quizAssignments.quizId, somaQuizzes.id))
        .innerJoin(somaUsers, eq(quizAssignments.studentId, somaUsers.id))
        .where(and(
          inArray(quizAssignments.studentId, adoptedIds),
          eq(quizAssignments.status, "pending"),
        ))
        .orderBy(sql`${quizAssignments.createdAt} desc`),
    ]);

    const cohortAverages = subjectAvgRows
      .filter((r) => r.totalMax > 0)
      .filter((r) => unionVisibleSubjects.has((r.subject || "").toLowerCase()))
      .map((r) => ({ subject: r.subject, average: Math.round((r.totalScore / r.totalMax) * 100), count: r.cnt }));

    const recentSubmissions = recentRows
      .filter((r) => {
        const subj = (r.subject || "").toLowerCase();
        if (!subj) return true; // keep uncategorized submissions visible
        return unionVisibleSubjects.has(subj);
      })
      .map((r) => ({
      reportId: r.reportId,
      // Non-null here: the query's inArray(studentId, adoptedIds) already excludes rows with null studentId.
      studentId: r.studentId ?? "",
      studentName: r.studentName,
      score: r.maxScore > 0 ? Math.round((r.score / r.maxScore) * 100) : 0,
      quizTitle: r.quizTitle,
      subject: r.subject,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    }));

    const pendingAssignments = pendingRows.map((r) => ({
      assignmentId: r.assignmentId,
      quizId: r.quizId,
      quizTitle: r.quizTitle,
      subject: r.subject,
      studentId: r.studentId,
      studentName: r.studentName,
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      createdAt: r.assignedAt.toISOString(),
    }));

    const insights: { studentId: string; studentName: string; assigned: number; completed: number; awaiting: number; trend: "improving" | "declining" | "stable"; weakTopics: string[] }[] = [];
    for (const sid of adoptedIds) {
      const [student] = await this.database.select().from(somaUsers).where(eq(somaUsers.id, sid));
      const studentAssignments = await this.database.select({ status: quizAssignments.status }).from(quizAssignments).where(eq(quizAssignments.studentId, sid));
      const assigned = studentAssignments.length;
      const completed = studentAssignments.filter((a) => a.status === "completed").length;
      const awaiting = studentAssignments.filter((a) => a.status !== "completed").length;

      const reportRows = await this.database
        .select({ score: somaReports.score, quizId: somaReports.quizId, subject: somaQuizzes.subject })
        .from(somaReports)
        .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
        .where(eq(somaReports.studentId, sid))
        .orderBy(desc(somaReports.createdAt))
        .limit(6);
      const recent = reportRows.slice(0, 3).map((r) => r.score);
      const prev = reportRows.slice(3, 6).map((r) => r.score);
      const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
      const prevAvg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : recentAvg;
      const trend: "improving" | "declining" | "stable" = recentAvg - prevAvg > 5 ? "improving" : prevAvg - recentAvg > 5 ? "declining" : "stable";

      const studentVisible = visibleSubjectKeys(sid);
      const weakTopics = Object.entries(reportRows.reduce<Record<string, { s: number; c: number }>>((acc, row) => {
        const k = row.subject || "General";
        if (!acc[k]) acc[k] = { s: 0, c: 0 };
        acc[k].s += row.score;
        acc[k].c += 1;
        return acc;
      }, {}))
        .map(([topic, v]) => ({ topic, avg: v.c ? v.s / v.c : 0 }))
        .filter((x) => x.avg < 55)
        // Only surface weaknesses in subjects the tutor has assigned this student.
        .filter((x) => studentVisible.has(x.topic.toLowerCase()))
        .sort((a, b) => a.avg - b.avg)
        .map((x) => x.topic)
        .slice(0, 3);

      insights.push({
        studentId: sid,
        studentName: student?.displayName || student?.email || "Student",
        assigned,
        completed,
        awaiting,
        trend,
        weakTopics,
      });
    }

    const belowThresholdCount = insights.filter((s) => s.weakTopics.length > 0 || s.trend === "declining").length;
    const topicWeaknessMap: Record<string, number> = {};
    for (const s of insights) {
      for (const t of s.weakTopics) {
        topicWeaknessMap[t] = (topicWeaknessMap[t] || 0) + 1;
      }
    }
    const weakestTopic = Object.entries(topicWeaknessMap)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || null;

    return {
      totalStudents,
      totalQuizzes: quizCountResult[0]?.cnt ?? 0,
      cohortAverages,
      recentSubmissions,
      pendingAssignments,
      studentInsights: insights.sort((a, b) => (b.awaiting + (b.trend === "declining" ? 2 : 0)) - (a.awaiting + (a.trend === "declining" ? 2 : 0))),
      belowThresholdCount,
      weakestTopic,
    };
  }

  async getAllSomaUsers(): Promise<SomaUser[]> {
    return this.database.select().from(somaUsers).orderBy(somaUsers.createdAt);
  }

  async deleteSomaUser(userId: string): Promise<void> {
    // Cascade: remove tutor-student relationships
    await this.database.delete(tutorStudents).where(
      or(eq(tutorStudents.tutorId, userId), eq(tutorStudents.studentId, userId))
    );
    // Cascade: remove tutor comments
    await this.database.delete(tutorComments).where(
      or(eq(tutorComments.tutorId, userId), eq(tutorComments.studentId, userId))
    );
    // Cascade: remove quiz assignments
    await this.database.delete(quizAssignments).where(eq(quizAssignments.studentId, userId));
    // Cascade: remove reports (submissions)
    await this.database.delete(somaReports).where(eq(somaReports.studentId, userId));
    // Set authored quizzes to null author (don't delete quizzes)
    await this.database.update(somaQuizzes).set({ authorId: null }).where(eq(somaQuizzes.authorId, userId));
    // Finally delete the user
    await this.database.delete(somaUsers).where(eq(somaUsers.id, userId));
  }

  async deleteSomaQuiz(quizId: number): Promise<void> {
    await this.database.delete(somaQuestions).where(eq(somaQuestions.quizId, quizId));
    await this.database.delete(somaReports).where(eq(somaReports.quizId, quizId));
    await this.database.delete(quizAssignments).where(eq(quizAssignments.quizId, quizId));
    await this.database.delete(somaQuizzes).where(eq(somaQuizzes.id, quizId));
  }

  async getAllSomaQuizzes(): Promise<SomaQuiz[]> {
    return this.database.select().from(somaQuizzes).orderBy(somaQuizzes.createdAt);
  }

  async touchUserLastLogin(userId: string): Promise<void> {
    await this.database.update(somaUsers).set({ lastLoginAt: new Date() }).where(eq(somaUsers.id, userId));
  }

  async getTutorDashboardSummaries(): Promise<TutorDashboardSummary[]> {
    const tutors = await this.database.select().from(somaUsers).where(eq(somaUsers.role, "tutor"));
    const summaries: TutorDashboardSummary[] = [];

    for (const tutor of tutors) {
      const adoptedStudents = await this.database
        .select({ studentId: tutorStudents.studentId })
        .from(tutorStudents)
        .where(eq(tutorStudents.tutorId, tutor.id));
      const adoptedStudentIds = adoptedStudents.map((row) => row.studentId);

      const reportRows = adoptedStudentIds.length === 0
        ? []
        : await this.database
          .select({
            reportId: somaReports.id,
            quizId: somaReports.quizId,
            score: somaReports.score,
            subject: somaQuizzes.subject,
          })
          .from(somaReports)
          .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
          .where(inArray(somaReports.studentId, adoptedStudentIds));

      const authoredSubjects = await this.database
        .select({ subject: somaQuizzes.subject })
        .from(somaQuizzes)
        .where(eq(somaQuizzes.authorId, tutor.id));

      const maxScoresByQuiz = await this.getSomaQuestionTotalsByQuizIds(
        Array.from(new Set(reportRows.map((row) => row.quizId))),
      );
      const averageStudentGrade = reportRows.length === 0
        ? null
        : Math.round((reportRows.reduce((acc, row) => {
          const max = maxScoresByQuiz[row.quizId] || 0;
          return acc + (max > 0 ? (row.score / max) * 100 : 0);
        }, 0) / reportRows.length) * 10) / 10;

      const subjects = Array.from(new Set([
        ...authoredSubjects.map((s) => s.subject).filter((s): s is string => Boolean(s)),
        ...reportRows.map((r) => r.subject).filter((s): s is string => Boolean(s)),
      ])).sort((a, b) => a.localeCompare(b));

      summaries.push({
        tutorId: tutor.id,
        tutorEmail: tutor.email,
        tutorName: tutor.displayName,
        adoptedStudentsCount: adoptedStudentIds.length,
        assessmentsCompletedCount: reportRows.length,
        averageStudentGrade,
        subjects,
        lastLoginAt: tutor.lastLoginAt ? tutor.lastLoginAt.toISOString() : null,
      });
    }

    return summaries.sort((a, b) => b.assessmentsCompletedCount - a.assessmentsCompletedCount);
  }

  async getTutorDashboardDetail(tutorId: string): Promise<TutorDashboardDetail | undefined> {
    const summary = (await this.getTutorDashboardSummaries()).find((row) => row.tutorId === tutorId);
    if (!summary) return undefined;

    const students = await this.getAdoptedStudents(tutorId);
    const studentIds = students.map((s) => s.id);
    const recentRows = studentIds.length === 0
      ? []
      : await this.database
        .select({
          reportId: somaReports.id,
          studentName: somaReports.studentName,
          quizId: somaReports.quizId,
          quizTitle: somaQuizzes.title,
          subject: somaQuizzes.subject,
          score: somaReports.score,
          completedAt: somaReports.completedAt,
          createdAt: somaReports.createdAt,
        })
        .from(somaReports)
        .innerJoin(somaQuizzes, eq(somaReports.quizId, somaQuizzes.id))
        .where(inArray(somaReports.studentId, studentIds))
        .orderBy(sql`${somaReports.createdAt} desc`)
        .limit(12);

    const maxScoresByQuiz = await this.getSomaQuestionTotalsByQuizIds(
      Array.from(new Set(recentRows.map((row) => row.quizId))),
    );

    return {
      ...summary,
      students: students.map((s) => ({ id: s.id, name: s.displayName, email: s.email })),
      recentAssessments: recentRows.map((row) => ({
        reportId: row.reportId,
        studentName: row.studentName,
        quizId: row.quizId,
        quizTitle: row.quizTitle,
        subject: row.subject,
        scorePercent: maxScoresByQuiz[row.quizId] > 0 ? Math.round((row.score / maxScoresByQuiz[row.quizId]) * 1000) / 10 : 0,
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async logPasswordResetRequest(email: string): Promise<void> {
    await this.database.execute(
      sql`INSERT INTO password_reset_requests (email) VALUES (${email})`
    );
  }
}

class MemoryStorage implements IStorage {
  private somaQuizzesList: SomaQuiz[] = [];
  private somaQuestionsList: SomaQuestion[] = [];
  private somaUsersList: SomaUser[] = [];
  private somaReportsList: SomaReport[] = [];
  private tutorStudentsList: TutorStudent[] = [];
  private quizAssignmentsList: QuizAssignment[] = [];
  private tutorCommentsList: TutorComment[] = [];
  private syllabusDocumentsList: SyllabusDocument[] = [];
  private syllabusChunksList: SyllabusChunk[] = [];
  private studentSubjectsList: StudentSubject[] = [];
  private studentTopicMasteryList: StudentTopicMastery[] = [];
  private tutorNotificationsList: TutorNotification[] = [];
  private suggestedAssessmentsList: SuggestedAssessment[] = [];
  private examinerMisconceptionsList: ExaminerMisconception[] = [];
  private syllabusTopicInventoryList: SyllabusTopicInventoryItem[] = [];
  private studentNotificationsList: StudentNotification[] = [];
  private flaggedQuestionsList: FlaggedQuestion[] = [];
  private somaQuizId = 1;
  private somaQuestionId = 1;
  private somaReportId = 1;
  private tutorStudentId = 1;
  private quizAssignmentId = 1;
  private syllabusDocumentId = 1;
  private syllabusChunkId = 1;
  private studentSubjectId = 1;
  private studentMasteryId = 1;
  private tutorNotificationId = 1;
  private suggestedAssessmentId = 1;
  private examinerMisconceptionId = 1;
  private syllabusTopicInventoryId = 1;
  private studentNotificationId = 1;
  private flaggedQuestionId = 1;

  async createSomaQuiz(quiz: InsertSomaQuiz): Promise<SomaQuiz> {
    const created: SomaQuiz = {
      id: this.somaQuizId++,
      createdAt: new Date(),
      title: quiz.title,
      topic: quiz.topic,
      topics: Array.isArray(quiz.topics) ? [...quiz.topics] : [],
      syllabus: quiz.syllabus ?? null,
      level: quiz.level ?? null,
      subject: quiz.subject ?? null,
      curriculumContext: quiz.curriculumContext ?? null,
      authorId: quiz.authorId ?? null,
      timeLimitMinutes: quiz.timeLimitMinutes ?? 60,
      status: quiz.status ?? "published",
      isArchived: quiz.isArchived ?? false,
    };
    this.somaQuizzesList.push(created);
    return created;
  }

  async createSomaQuizBundle(input: {
    quiz: InsertSomaQuiz;
    questions: SomaQuizBundleQuestionInput[];
    assignedStudentIds?: string[];
  }): Promise<{ quiz: SomaQuiz; questions: SomaQuestion[]; assignments: QuizAssignment[] }> {
    const quiz = await this.createSomaQuiz(input.quiz);
    const questions = await this.createSomaQuestions(input.questions.map((q) => ({ ...q, quizId: quiz.id })));
    const assignments = await this.createQuizAssignments(quiz.id, Array.from(new Set(input.assignedStudentIds ?? [])));
    return { quiz, questions, assignments };
  }

  async getSomaQuizzes(): Promise<SomaQuiz[]> { return [...this.somaQuizzesList]; }
  async getSomaQuiz(id: number): Promise<SomaQuiz | undefined> { return this.somaQuizzesList.find((q) => q.id === id); }

  async updateSomaQuiz(id: number, data: Partial<InsertSomaQuiz>): Promise<SomaQuiz | undefined> {
    const idx = this.somaQuizzesList.findIndex((q) => q.id === id);
    if (idx === -1) return undefined;
    this.somaQuizzesList[idx] = { ...this.somaQuizzesList[idx], ...data };
    return this.somaQuizzesList[idx];
  }

  async createSomaQuestions(questionList: InsertSomaQuestion[]): Promise<SomaQuestion[]> {
    const created = questionList.map((q) => ({
      id: this.somaQuestionId++,
      quizId: q.quizId,
      stem: q.stem,
      options: Array.isArray(q.options) ? [...(q.options as string[])] : [],
      correctAnswer: q.correctAnswer,
      explanation: q.explanation,
      marks: q.marks ?? 1,
      questionType: q.questionType ?? "multiple_choice",
      graphSpec: (q.graphSpec ?? null) as any,
      topicTag: q.topicTag ?? null,
      subtopicTag: q.subtopicTag ?? null,
      difficultyTag: q.difficultyTag ?? null,
    }));
    this.somaQuestionsList.push(...created);
    return created;
  }

  async getSomaQuestionsByQuizId(quizId: number): Promise<SomaQuestion[]> {
    return this.somaQuestionsList.filter((q) => q.quizId === quizId);
  }

  async getSomaQuestionTotalsByQuizIds(quizIds: number[]): Promise<Record<number, number>> {
    const wanted = new Set(quizIds);
    const totals: Record<number, number> = {};
    for (const q of this.somaQuestionsList) {
      if (!wanted.has(q.quizId)) continue;
      totals[q.quizId] = (totals[q.quizId] || 0) + q.marks;
    }
    return totals;
  }

  async deleteSomaQuestion(id: number): Promise<void> {
    this.somaQuestionsList = this.somaQuestionsList.filter((q) => q.id !== id);
  }

  async deleteSomaQuestionsByQuizId(quizId: number): Promise<void> {
    this.somaQuestionsList = this.somaQuestionsList.filter((q) => q.quizId !== quizId);
  }

  async publishSomaQuestionsTransactional(quizId: number, questionList: InsertSomaQuestion[]): Promise<SomaQuestion[]> {
    this.somaQuestionsList = this.somaQuestionsList.filter((q) => q.quizId !== quizId);
    return this.createSomaQuestions(questionList);
  }

  async upsertSomaUser(user: InsertSomaUser): Promise<SomaUser> {
    const idx = this.somaUsersList.findIndex((u) => u.id === user.id);
    const record: SomaUser = { createdAt: new Date(), displayName: null, role: "student", lastLoginAt: null, ...user };
    if (idx >= 0) {
      this.somaUsersList[idx] = { ...this.somaUsersList[idx], email: user.email, displayName: user.displayName ?? this.somaUsersList[idx].displayName, role: user.role ?? this.somaUsersList[idx].role };
      return this.somaUsersList[idx];
    }
    this.somaUsersList.push(record);
    return record;
  }

  async getSomaReportsByStudentId(_studentId: string): Promise<(SomaReport & { quiz: SomaQuiz })[]> {
    return [];
  }

  async createSomaReport(report: InsertSomaReport): Promise<SomaReport> {
    const created: SomaReport = { id: this.somaReportId++, createdAt: new Date(), aiFeedbackHtml: null, answersJson: null, status: "pending", studentId: report.studentId ?? null, startedAt: null, completedAt: null, ...report };
    this.somaReportsList.push(created);
    return created;
  }

  async updateSomaReport(reportId: number, data: Partial<{ status: string; aiFeedbackHtml: string | null }>): Promise<SomaReport | undefined> {
    const report = this.somaReportsList.find((r) => r.id === reportId);
    if (!report) return undefined;
    Object.assign(report, data);
    return report;
  }

  async checkSomaSubmission(quizId: number, studentId: string): Promise<boolean> {
    return this.somaReportsList.some((r) => r.quizId === quizId && r.studentId === studentId);
  }

  async getSomaReportById(reportId: number): Promise<(SomaReport & { quiz: SomaQuiz }) | undefined> {
    const report = this.somaReportsList.find((r) => r.id === reportId);
    if (!report) return undefined;
    const quiz = this.somaQuizzesList.find((q) => q.id === report.quizId);
    if (!quiz) return undefined;
    return { ...report, quiz };
  }

  async getSomaReportsByQuizId(quizId: number): Promise<(SomaReport & { quiz: SomaQuiz })[]> {
    return this.somaReportsList
      .filter((r) => r.quizId === quizId)
      .map((r) => {
        const quiz = this.somaQuizzesList.find((q) => q.id === r.quizId);
        if (!quiz) return null;
        return { ...r, quiz };
      })
      .filter(Boolean) as (SomaReport & { quiz: SomaQuiz })[];
  }

  async getSomaUserByEmail(email: string): Promise<SomaUser | undefined> {
    return this.somaUsersList.find((u) => u.email === email);
  }

  async getSomaUserById(id: string): Promise<SomaUser | undefined> {
    return this.somaUsersList.find((u) => u.id === id);
  }

  async getAllStudents(): Promise<SomaUser[]> {
    return this.somaUsersList.filter((u) => u.role === "student");
  }

  async adoptStudent(tutorId: string, studentId: string): Promise<TutorStudent> {
    const existing = this.tutorStudentsList.find((ts) => ts.tutorId === tutorId && ts.studentId === studentId);
    if (existing) return existing;
    const record: TutorStudent = { id: this.tutorStudentId++, tutorId, studentId, createdAt: new Date() };
    this.tutorStudentsList.push(record);
    return record;
  }

  async removeAdoptedStudent(tutorId: string, studentId: string): Promise<void> {
    this.tutorStudentsList = this.tutorStudentsList.filter(
      (ts) => !(ts.tutorId === tutorId && ts.studentId === studentId)
    );
  }

  async getAdoptedStudents(tutorId: string): Promise<SomaUser[]> {
    const adoptedIds = this.tutorStudentsList.filter((ts) => ts.tutorId === tutorId).map((ts) => ts.studentId);
    return this.somaUsersList.filter((u) => adoptedIds.includes(u.id));
  }

  async getAvailableStudents(tutorId: string): Promise<SomaUser[]> {
    // Step 1: Fetch ALL adopted student IDs for this tutor
    const adoptedIds = new Set(this.tutorStudentsList.filter((ts) => ts.tutorId === tutorId).map((ts) => ts.studentId));

    // Step 2: Get all users where role = 'student' OR role IS NULL
    const allStudents = this.somaUsersList.filter(
      (u) => u.role === "student" || u.role === null
    );

    // Step 3: Filter in plain JS — this cannot fail
    return allStudents.filter((s) => s.id !== tutorId && !adoptedIds.has(s.id));
  }

  async createQuizAssignments(quizId: number, studentIds: string[], dueDate?: Date | null): Promise<QuizAssignment[]> {
    const created: QuizAssignment[] = [];
    for (const studentId of studentIds) {
      const existing = this.quizAssignmentsList.find((qa) => qa.quizId === quizId && qa.studentId === studentId);
      if (!existing) {
        const record: QuizAssignment = { id: this.quizAssignmentId++, quizId, studentId, status: "pending", dueDate: dueDate || null, createdAt: new Date() };
        this.quizAssignmentsList.push(record);
        created.push(record);
      }
    }
    return created;
  }

  async getQuizAssignmentsForStudent(studentId: string): Promise<(QuizAssignment & { quiz: SomaQuiz })[]> {
    return this.quizAssignmentsList
      .filter((qa) => qa.studentId === studentId)
      .map((qa) => {
        const quiz = this.somaQuizzesList.find((q) => q.id === qa.quizId);
        if (!quiz) return null;
        return { ...qa, quiz };
      })
      .filter(Boolean) as (QuizAssignment & { quiz: SomaQuiz })[];
  }

  async getQuizAssignmentsForQuiz(quizId: number): Promise<(QuizAssignment & { student: SomaUser })[]> {
    return this.quizAssignmentsList
      .filter((qa) => qa.quizId === quizId)
      .map((qa) => {
        const student = this.somaUsersList.find((u) => u.id === qa.studentId);
        if (!student) return null;
        return { ...qa, student };
      })
      .filter(Boolean) as (QuizAssignment & { student: SomaUser })[];
  }

  async getAssignedSubjectsForStudents(studentIds: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const id of studentIds) result[id] = [];
    const idSet = new Set(studentIds);
    for (const qa of this.quizAssignmentsList) {
      if (!idSet.has(qa.studentId)) continue;
      const quiz = this.somaQuizzesList.find((q) => q.id === qa.quizId);
      const subject = (quiz?.subject || "").trim();
      if (!subject) continue;
      const list = result[qa.studentId] ?? (result[qa.studentId] = []);
      if (!list.some((s) => s.toLowerCase() === subject.toLowerCase())) list.push(subject);
    }
    return result;
  }

  async updateQuizAssignmentStatus(quizId: number, studentId: string, status: string): Promise<void> {
    const qa = this.quizAssignmentsList.find((a) => a.quizId === quizId && a.studentId === studentId);
    if (qa) qa.status = status;
  }

  async getTutorAssessmentsOverview(tutorId: string): Promise<Array<{
    quizId: number;
    assignedStudentIds: string[];
    latestSubmissionAt: string | null;
  }>> {
    const quizzes = this.somaQuizzesList.filter((q) => q.authorId === tutorId);
    return quizzes.map((quiz) => {
      const assignedStudentIds = Array.from(
        new Set(this.quizAssignmentsList.filter((a) => a.quizId === quiz.id).map((a) => a.studentId))
      );
      const reports = this.somaReportsList.filter((r) => r.quizId === quiz.id);
      const latestTs = reports.reduce<number>((acc, r) => {
        const ts = r.completedAt ?? r.createdAt;
        if (!ts) return acc;
        const t = new Date(ts as any).getTime();
        return t > acc ? t : acc;
      }, 0);
      return {
        quizId: quiz.id,
        assignedStudentIds,
        latestSubmissionAt: latestTs > 0 ? new Date(latestTs).toISOString() : null,
      };
    });
  }

  async deleteQuizAssignment(quizId: number, studentId: string): Promise<void> {
    this.somaReportsList = this.somaReportsList.filter(
      (r) => !(r.quizId === quizId && r.studentId === studentId)
    );
    this.quizAssignmentsList = this.quizAssignmentsList.filter(
      (a) => !(a.quizId === quizId && a.studentId === studentId)
    );
  }

  async extendQuizAssignmentDeadlines(quizId: number, hours: number): Promise<number> {
    let count = 0;
    for (const a of this.quizAssignmentsList) {
      if (a.quizId === quizId && a.status === "pending") {
        const base = a.dueDate ? new Date(a.dueDate) : new Date();
        a.dueDate = new Date(base.getTime() + hours * 60 * 60 * 1000);
        count++;
      }
    }
    return count;
  }

  async updateQuizAssignmentsDueDate(quizId: number, dueDate: Date | null): Promise<number> {
    let count = 0;
    for (const a of this.quizAssignmentsList) {
      if (a.quizId === quizId) {
        a.dueDate = dueDate;
        count++;
      }
    }
    return count;
  }

  async getSomaQuizzesByAuthor(authorId: string): Promise<SomaQuiz[]> {
    return this.somaQuizzesList.filter((q) => q.authorId === authorId);
  }

  async addTutorComment(comment: InsertTutorComment): Promise<TutorComment> {
    const tc: TutorComment = { id: this.tutorCommentsList.length + 1, ...comment, createdAt: new Date() };
    this.tutorCommentsList.push(tc);
    return tc;
  }

  async getTutorComments(tutorId: string, studentId: string): Promise<TutorComment[]> {
    return this.tutorCommentsList.filter((c) => c.tutorId === tutorId && c.studentId === studentId);
  }

  async getDashboardStatsForTutor(tutorId: string) {
    const adoptedIds = this.tutorStudentsList.filter((ts) => ts.tutorId === tutorId).map((ts) => ts.studentId);
    return { totalStudents: adoptedIds.length, totalQuizzes: 0, cohortAverages: [], recentSubmissions: [], pendingAssignments: [], studentInsights: [], belowThresholdCount: 0, weakestTopic: null };
  }


  async createSyllabusDocument(document: InsertSyllabusDocument, chunks: Omit<InsertSyllabusChunk, "documentId">[]): Promise<{ document: SyllabusDocument; chunks: SyllabusChunk[] }> {
    const createdDocument: SyllabusDocument = {
      ...document,
      id: this.syllabusDocumentId++,
      uploadedAt: new Date(),
      tutorId: document.tutorId ?? null,
      documentType: document.documentType ?? "syllabus",
      subject: document.subject ?? null,
      originalPath: document.originalPath ?? null,
      contentHash: document.contentHash ?? null,
    };
    this.syllabusDocumentsList.push(createdDocument);
    const createdChunks: SyllabusChunk[] = chunks.map((chunk) => ({ id: this.syllabusChunkId++, documentId: createdDocument.id, ...chunk }));
    this.syllabusChunksList.push(...createdChunks);
    return { document: createdDocument, chunks: createdChunks };
  }

  async listSyllabusDocuments(tutorId?: string): Promise<SyllabusDocument[]> {
    if (!tutorId) return [...this.syllabusDocumentsList];
    return this.syllabusDocumentsList.filter((doc) => doc.tutorId === tutorId || doc.tutorId === null);
  }

  async listCanonicalSyllabi(filter: { subject?: string; level?: string; board?: string } = {}): Promise<SyllabusDocument[]> {
    return this.syllabusDocumentsList.filter((doc) =>
      doc.tutorId === null &&
      doc.documentType === "syllabus" &&
      (!filter.board || doc.board === filter.board) &&
      (!filter.level || doc.level === filter.level) &&
      (!filter.subject || doc.subject === filter.subject)
    );
  }

  async getSyllabusDocumentBySelection(selection: { board: string; level: string; syllabusCode: string; tutorId?: string }): Promise<(SyllabusDocument & { chunks: SyllabusChunk[] }) | undefined> {
    const document = this.syllabusDocumentsList.find((doc) => doc.board === selection.board && doc.level === selection.level && doc.syllabusCode === selection.syllabusCode && (!selection.tutorId || doc.tutorId === selection.tutorId || doc.tutorId === null));
    if (!document) return undefined;
    const chunks = this.syllabusChunksList.filter((chunk) => chunk.documentId === document.id);
    return { ...document, chunks };
  }

  async getSyllabusDocumentByHash(contentHash: string): Promise<SyllabusDocument | undefined> {
    return this.syllabusDocumentsList.find((doc) => doc.contentHash === contentHash);
  }

  async listStudentSubjects(studentId: string): Promise<StudentSubject[]> {
    return this.studentSubjectsList.filter((s) => s.studentId === studentId);
  }

  async addStudentSubject(subject: InsertStudentSubject): Promise<StudentSubject> {
    const row: StudentSubject = { id: this.studentSubjectId++, createdAt: new Date(), updatedAt: new Date(), ...subject };
    this.studentSubjectsList.push(row);
    return row;
  }

  async updateStudentSubject(id: number, studentId: string, data: Partial<InsertStudentSubject>): Promise<StudentSubject | undefined> {
    const row = this.studentSubjectsList.find((s) => s.id === id && s.studentId === studentId);
    if (!row) return undefined;
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }

  async upsertStudentTopicMastery(input: {
    studentId: string;
    subject: string;
    topic: string;
    subtopic?: string | null;
    understandingPercent: number;
    masteryAchieved?: boolean;
    covered?: boolean;
    tested?: boolean;
    totalQuestions?: number;
    correctQuestions?: number;
  }): Promise<StudentTopicMastery> {
    const clampedPercent = Math.max(0, Math.min(100, Math.round(input.understandingPercent)));
    const totalQ = input.totalQuestions ?? 0;
    const confidenceLevel = totalQ >= 10 ? "high" : totalQ >= 5 ? "medium" : "low";
    const existing = this.studentTopicMasteryList.find((m) =>
      m.studentId === input.studentId
      && m.subject === input.subject
      && m.topic === input.topic
      && (m.subtopic || null) === (input.subtopic || null)
    );
    if (existing) {
      existing.understandingPercent = clampedPercent;
      const newTotalQ = existing.totalQuestions + totalQ;
      existing.masteryAchieved = input.masteryAchieved ?? (clampedPercent >= 75 && newTotalQ >= 5);
      existing.covered = Boolean(input.covered);
      existing.tested = Boolean(input.tested);
      existing.attempts += 1;
      existing.totalQuestions = newTotalQ;
      existing.correctQuestions += input.correctQuestions ?? 0;
      existing.confidenceLevel = (newTotalQ >= 10 ? "high" : newTotalQ >= 5 ? "medium" : "low");
      existing.lastTestedAt = new Date();
      // Spaced repetition scheduling
      if (existing.masteryAchieved) {
        existing.nextReviewAt = computeNextReviewDate(existing.nextReviewAt, existing.attempts);
      } else {
        existing.nextReviewAt = null;
      }
      existing.updatedAt = new Date();
      return existing;
    }
    const mastered = input.masteryAchieved ?? (clampedPercent >= 75 && totalQ >= 5);
    const row: StudentTopicMastery = {
      id: this.studentMasteryId++,
      studentId: input.studentId,
      subject: input.subject,
      topic: input.topic,
      subtopic: input.subtopic || null,
      understandingPercent: clampedPercent,
      masteryAchieved: mastered,
      covered: Boolean(input.covered),
      tested: Boolean(input.tested),
      attempts: 1,
      totalQuestions: totalQ,
      correctQuestions: input.correctQuestions ?? 0,
      confidenceLevel,
      lastTestedAt: new Date(),
      nextReviewAt: mastered ? computeNextReviewDate(null, 0) : null,
      updatedAt: new Date(),
    };
    this.studentTopicMasteryList.push(row);
    return row;
  }

  async listStudentTopicMastery(studentId: string): Promise<StudentTopicMastery[]> {
    return this.studentTopicMasteryList.filter((m) => m.studentId === studentId);
  }

  async createTutorNotification(notification: InsertTutorNotification): Promise<TutorNotification> {
    const row: TutorNotification = { id: this.tutorNotificationId++, createdAt: new Date(), readAt: null, payload: null, studentId: null, ...notification };
    this.tutorNotificationsList.push(row);
    return row;
  }

  async listTutorNotifications(tutorId: string): Promise<TutorNotification[]> {
    return this.tutorNotificationsList.filter((n) => n.tutorId === tutorId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async markTutorNotificationRead(notificationId: number, tutorId: string): Promise<TutorNotification | undefined> {
    const row = this.tutorNotificationsList.find((n) => n.id === notificationId && n.tutorId === tutorId);
    if (!row) return undefined;
    row.readAt = new Date();
    return row;
  }

  async createSuggestedAssessment(suggestion: InsertSuggestedAssessment): Promise<SuggestedAssessment> {
    const row: SuggestedAssessment = {
      id: this.suggestedAssessmentId++,
      createdAt: new Date(),
      generatedQuizId: null,
      subtopic: null,
      status: suggestion.status ?? "suggested",
      targetDifficulty: suggestion.targetDifficulty ?? "medium",
      ...suggestion,
    };
    this.suggestedAssessmentsList.push(row);
    return row;
  }

  async listSuggestedAssessments(tutorId: string, studentId: string): Promise<SuggestedAssessment[]> {
    return this.suggestedAssessmentsList.filter((s) => s.tutorId === tutorId && s.studentId === studentId);
  }

  async updateSuggestedAssessmentStatus(id: number, tutorId: string, status: string, generatedQuizId?: number): Promise<SuggestedAssessment | undefined> {
    const row = this.suggestedAssessmentsList.find((s) => s.id === id && s.tutorId === tutorId);
    if (!row) return undefined;
    row.status = status;
    row.generatedQuizId = generatedQuizId ?? null;
    return row;
  }

  async deleteStudentSubject(id: number, studentId: string): Promise<void> {
    this.studentSubjectsList = this.studentSubjectsList.filter(
      (s) => !(s.id === id && s.studentId === studentId)
    );
  }

  async createExaminerMisconceptions(items: InsertExaminerMisconception[]): Promise<ExaminerMisconception[]> {
    return items.map((item) => {
      const row: ExaminerMisconception = { id: this.examinerMisconceptionId++, extractedAt: new Date(), ...item, subject: item.subject ?? null, subtopic: item.subtopic ?? null, frequency: item.frequency ?? "common" };
      this.examinerMisconceptionsList.push(row);
      return row;
    });
  }

  async listExaminerMisconceptions(filter: { board?: string; syllabusCode?: string; topic?: string }): Promise<ExaminerMisconception[]> {
    return this.examinerMisconceptionsList.filter((m) =>
      (!filter.board || m.board === filter.board) &&
      (!filter.syllabusCode || m.syllabusCode === filter.syllabusCode) &&
      (!filter.topic || m.topic === filter.topic)
    );
  }

  async createSyllabusTopicInventory(items: InsertSyllabusTopicInventoryItem[]): Promise<SyllabusTopicInventoryItem[]> {
    return items.map((item) => {
      const row: SyllabusTopicInventoryItem = { id: this.syllabusTopicInventoryId++, extractedAt: new Date(), ...item, subject: item.subject ?? null, subtopic: item.subtopic ?? null, description: item.description ?? null };
      this.syllabusTopicInventoryList.push(row);
      return row;
    });
  }

  async listSyllabusTopicInventory(filter: { board?: string; syllabusCode?: string; subject?: string }): Promise<SyllabusTopicInventoryItem[]> {
    return this.syllabusTopicInventoryList.filter((t) =>
      (!filter.board || t.board === filter.board) &&
      (!filter.syllabusCode || t.syllabusCode === filter.syllabusCode) &&
      (!filter.subject || t.subject === filter.subject)
    );
  }

  async getAllSomaUsers(): Promise<SomaUser[]> {
    return this.somaUsersList;
  }

  async deleteSomaUser(userId: string): Promise<void> {
    this.tutorStudentsList = this.tutorStudentsList.filter(
      (ts) => ts.tutorId !== userId && ts.studentId !== userId
    );
    this.tutorCommentsList = this.tutorCommentsList.filter(
      (c) => c.tutorId !== userId && c.studentId !== userId
    );
    this.quizAssignmentsList = this.quizAssignmentsList.filter(
      (qa) => qa.studentId !== userId
    );
    for (const r of this.somaReportsList) {
      if (r.studentId === userId) r.studentId = null;
    }
    this.somaUsersList = this.somaUsersList.filter((u) => u.id !== userId);
  }

  async deleteSomaQuiz(quizId: number): Promise<void> {
    this.somaQuestionsList = this.somaQuestionsList.filter((q) => q.quizId !== quizId);
    this.somaReportsList = this.somaReportsList.filter((r) => r.quizId !== quizId);
    this.quizAssignmentsList = this.quizAssignmentsList.filter((qa) => qa.quizId !== quizId);
    this.somaQuizzesList = this.somaQuizzesList.filter((q) => q.id !== quizId);
  }

  async getAllSomaQuizzes(): Promise<SomaQuiz[]> {
    return this.somaQuizzesList;
  }

  async touchUserLastLogin(userId: string): Promise<void> {
    const user = this.somaUsersList.find((u) => u.id === userId);
    if (user) user.lastLoginAt = new Date();
  }

  async getTutorDashboardSummaries(): Promise<TutorDashboardSummary[]> {
    const tutors = this.somaUsersList.filter((u) => u.role === "tutor");
    return tutors.map((tutor) => {
      const adoptedIds = this.tutorStudentsList.filter((ts) => ts.tutorId === tutor.id).map((ts) => ts.studentId);
      const completed = this.somaReportsList.filter((r) => r.studentId && adoptedIds.includes(r.studentId));
      return {
        tutorId: tutor.id,
        tutorEmail: tutor.email,
        tutorName: tutor.displayName,
        adoptedStudentsCount: adoptedIds.length,
        assessmentsCompletedCount: completed.length,
        averageStudentGrade: completed.length ? Math.round((completed.reduce((sum, r) => sum + r.score, 0) / completed.length) * 10) / 10 : null,
        subjects: [],
        lastLoginAt: tutor.lastLoginAt ? tutor.lastLoginAt.toISOString() : null,
      };
    });
  }

  async getTutorDashboardDetail(tutorId: string): Promise<TutorDashboardDetail | undefined> {
    const summary = (await this.getTutorDashboardSummaries()).find((row) => row.tutorId === tutorId);
    if (!summary) return undefined;
    const students = this.tutorStudentsList
      .filter((ts) => ts.tutorId === tutorId)
      .map((ts) => this.somaUsersList.find((u) => u.id === ts.studentId))
      .filter((u): u is SomaUser => Boolean(u))
      .map((u) => ({ id: u.id, name: u.displayName, email: u.email }));
    return { ...summary, students, recentAssessments: [] };
  }

  async logPasswordResetRequest(_email: string): Promise<void> {
    // no-op in memory storage
  }

  async createStudentNotification(notification: InsertStudentNotification): Promise<StudentNotification> {
    const row: StudentNotification = {
      id: this.studentNotificationId++,
      createdAt: new Date(),
      readAt: null,
      payload: null,
      ...notification,
    };
    this.studentNotificationsList.push(row);
    return row;
  }

  async listStudentNotifications(studentId: string, options: { limit?: number } = {}): Promise<StudentNotification[]> {
    const limit = options.limit ?? 25;
    return this.studentNotificationsList
      .filter((n) => n.studentId === studentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async markStudentNotificationRead(notificationId: number, studentId: string): Promise<StudentNotification | undefined> {
    const row = this.studentNotificationsList.find((n) => n.id === notificationId && n.studentId === studentId);
    if (!row) return undefined;
    row.readAt = new Date();
    return row;
  }

  async markAllStudentNotificationsRead(studentId: string): Promise<number> {
    let n = 0;
    for (const row of this.studentNotificationsList) {
      if (row.studentId === studentId && !row.readAt) {
        row.readAt = new Date();
        n++;
      }
    }
    return n;
  }

  async flagQuestion(input: InsertFlaggedQuestion): Promise<FlaggedQuestion> {
    const existing = this.flaggedQuestionsList.find(
      (f) => f.studentId === input.studentId && f.questionId === input.questionId,
    );
    if (existing) {
      existing.quizId = input.quizId;
      existing.reportId = input.reportId ?? null;
      existing.reason = input.reason ?? null;
      existing.resolvedAt = null;
      existing.tutorViewedAt = null;
      existing.createdAt = new Date();
      return existing;
    }
    const row: FlaggedQuestion = {
      id: this.flaggedQuestionId++,
      studentId: input.studentId,
      questionId: input.questionId,
      quizId: input.quizId,
      reportId: input.reportId ?? null,
      reason: input.reason ?? null,
      resolvedAt: null,
      tutorViewedAt: null,
      createdAt: new Date(),
    };
    this.flaggedQuestionsList.push(row);
    return row;
  }

  async listFlaggedQuestionsForTutor(
    tutorId: string,
    filter: { quizId?: number; studentId?: string; unresolvedOnly?: boolean } = {},
  ): Promise<Array<FlaggedQuestion & { question: SomaQuestion; quiz: SomaQuiz; student: { id: string; displayName: string | null; email: string } }>> {
    return this.flaggedQuestionsList
      .map((flag) => {
        const quiz = this.somaQuizzesList.find((q) => q.id === flag.quizId);
        if (!quiz || quiz.authorId !== tutorId) return null;
        if (filter.quizId !== undefined && flag.quizId !== filter.quizId) return null;
        if (filter.studentId && flag.studentId !== filter.studentId) return null;
        if (filter.unresolvedOnly && flag.resolvedAt) return null;
        const question = this.somaQuestionsList.find((q) => q.id === flag.questionId);
        const student = this.somaUsersList.find((u) => u.id === flag.studentId);
        if (!question || !student) return null;
        return {
          ...flag,
          question,
          quiz,
          student: { id: student.id, displayName: student.displayName, email: student.email },
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listFlaggedQuestionsForStudent(studentId: string): Promise<Array<FlaggedQuestion & { question: SomaQuestion; quiz: SomaQuiz }>> {
    return this.flaggedQuestionsList
      .filter((f) => f.studentId === studentId)
      .map((flag) => {
        const quiz = this.somaQuizzesList.find((q) => q.id === flag.quizId);
        const question = this.somaQuestionsList.find((q) => q.id === flag.questionId);
        if (!quiz || !question) return null;
        return { ...flag, question, quiz };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async resolveFlaggedQuestion(flagId: number, tutorId: string): Promise<FlaggedQuestion | undefined> {
    const row = this.flaggedQuestionsList.find((f) => f.id === flagId);
    if (!row) return undefined;
    const quiz = this.somaQuizzesList.find((q) => q.id === row.quizId);
    if (!quiz || quiz.authorId !== tutorId) return undefined;
    row.resolvedAt = new Date();
    row.tutorViewedAt = new Date();
    return row;
  }

  async unflagQuestion(studentId: string, questionId: number): Promise<void> {
    this.flaggedQuestionsList = this.flaggedQuestionsList.filter(
      (f) => !(f.studentId === studentId && f.questionId === questionId),
    );
  }
}

let _storage: IStorage | null = null;

export function initStorage() {
  _storage = db ? new DatabaseStorage(db) : new MemoryStorage();
}

export const storage: IStorage = new Proxy({} as IStorage, {
  get(_target, prop, _receiver) {
    if (!_storage) {
      _storage = db ? new DatabaseStorage(db) : new MemoryStorage();
    }
    const val = (_storage as any)[prop as string];
    if (typeof val === "function") {
      return val.bind(_storage);
    }
    return val;
  },
});
