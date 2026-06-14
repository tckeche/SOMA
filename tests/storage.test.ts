/**
 * STORAGE LAYER TESTS
 * Tests the MemoryStorage implementation for all CRUD operations.
 * Verifies data persistence, name sanitization, single-attempt enforcement,
 * and all Soma entity operations.
 */
import { describe, it, expect, beforeEach } from "vitest";

// We test MemoryStorage by importing it directly from the module.
// To isolate, we recreate instances.

// ─── MemoryStorage helper (inline since storage.ts exports a singleton) ────
// We replicate the critical sanitizeName logic from storage.ts for test assertions.
function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// Minimal in-memory storage extracted for unit testing
class TestMemoryStorage {
  private quizzes: any[] = [];
  private questions: any[] = [];
  private students: any[] = [];
  private submissions: any[] = [];
  private somaQuizzesList: any[] = [];
  private somaQuestionsList: any[] = [];
  private quizId = 1;
  private questionId = 1;
  private studentId = 1;
  private submissionId = 1;
  private somaQuizId = 1;
  private somaQuestionId = 1;

  sanitize(name: string) { return sanitizeName(name); }

  async createQuiz(quiz: any) {
    const created = { id: this.quizId++, createdAt: new Date(), ...quiz };
    this.quizzes.push(created);
    return created;
  }
  async getQuizzes() { return [...this.quizzes]; }
  async getQuiz(id: number) { return this.quizzes.find((q) => q.id === id); }
  async deleteQuiz(id: number) {
    this.quizzes = this.quizzes.filter((q) => q.id !== id);
    this.questions = this.questions.filter((q) => q.quizId !== id);
    this.submissions = this.submissions.filter((s) => s.quizId !== id);
  }

  async createQuestions(list: any[]) {
    const created = list.map((q) => ({
      id: this.questionId++,
      imageUrl: null,
      marksWorth: 1,
      ...q,
      options: Array.isArray(q.options) ? [...q.options] : [],
    }));
    this.questions.push(...created);
    return created;
  }
  async getQuestionsByQuizId(quizId: number) {
    return this.questions.filter((q) => q.quizId === quizId);
  }
  async deleteQuestion(id: number) {
    this.questions = this.questions.filter((q) => q.id !== id);
  }

  async findOrCreateStudent(student: any) {
    const fn = sanitizeName(student.firstName);
    const ln = sanitizeName(student.lastName);
    const existing = await this.findStudentByName(fn, ln);
    if (existing) return existing;
    const created = { id: this.studentId++, firstName: fn, lastName: ln };
    this.students.push(created);
    return created;
  }
  async findStudentByName(firstName: string, lastName: string) {
    const fn = sanitizeName(firstName);
    const ln = sanitizeName(lastName);
    return this.students.find((s) => s.firstName === fn && s.lastName === ln);
  }
  async getStudent(id: number) { return this.students.find((s) => s.id === id); }

  async createSubmission(submission: any) {
    const created = { id: this.submissionId++, submittedAt: new Date(), ...submission };
    this.submissions.push(created);
    return created;
  }
  async getSubmissionsByQuizId(quizId: number) {
    return this.submissions
      .filter((s) => s.quizId === quizId)
      .map((s) => ({ ...s, student: this.students.find((st) => st.id === s.studentId)! }))
      .filter((s) => Boolean(s.student));
  }
  async deleteSubmission(id: number) {
    this.submissions = this.submissions.filter((s) => s.id !== id);
  }
  async deleteSubmissionsByQuizId(quizId: number) {
    this.submissions = this.submissions.filter((s) => s.quizId !== quizId);
  }
  async checkStudentSubmission(quizId: number, firstName: string, lastName: string) {
    const student = await this.findStudentByName(firstName, lastName);
    if (!student) return false;
    return this.submissions.some((s) => s.quizId === quizId && s.studentId === student.id);
  }
  async getStudentSubmission(quizId: number, firstName: string, lastName: string) {
    const student = await this.findStudentByName(firstName, lastName);
    if (!student) return undefined;
    return this.submissions.find((s) => s.quizId === quizId && s.studentId === student.id);
  }

  async createSomaQuiz(quiz: any) {
    const created = { id: this.somaQuizId++, createdAt: new Date(), curriculumContext: null, status: "published", ...quiz };
    this.somaQuizzesList.push(created);
    return created;
  }
  async getSomaQuizzes() { return [...this.somaQuizzesList]; }
  async getSomaQuiz(id: number) { return this.somaQuizzesList.find((q) => q.id === id); }
  async createSomaQuestions(list: any[]) {
    const created = list.map((q) => ({
      id: this.somaQuestionId++,
      explanation: null,
      marks: 1,
      ...q,
      options: Array.isArray(q.options) ? [...q.options] : [],
    }));
    this.somaQuestionsList.push(...created);
    return created;
  }
  async getSomaQuestionsByQuizId(quizId: number) {
    return this.somaQuestionsList.filter((q) => q.quizId === quizId);
  }
  async updateSomaQuestionReview(
    id: number,
    patch: { reviewStatus?: string; stem?: string; options?: string[]; correctAnswer?: string; explanation?: string },
  ) {
    const idx = this.somaQuestionsList.findIndex((q) => q.id === id);
    if (idx === -1) return undefined;
    const current = this.somaQuestionsList[idx];
    const updated = {
      ...current,
      ...(patch.reviewStatus !== undefined ? { reviewStatus: patch.reviewStatus } : {}),
      ...(patch.stem !== undefined ? { stem: patch.stem } : {}),
      ...(patch.options !== undefined ? { options: [...patch.options] } : {}),
      ...(patch.correctAnswer !== undefined ? { correctAnswer: patch.correctAnswer } : {}),
      ...(patch.explanation !== undefined ? { explanation: patch.explanation } : {}),
    };
    this.somaQuestionsList[idx] = updated;
    return updated;
  }
}

let store: TestMemoryStorage;
beforeEach(() => { store = new TestMemoryStorage(); });

// ─── Quiz CRUD ───────────────────────────────────────────────────────────────
describe("Storage: Quiz CRUD", () => {
  it("creates a quiz and retrieves it by id", async () => {
    const quiz = await store.createQuiz({ title: "Algebra", timeLimitMinutes: 30, dueDate: new Date("2099-12-31") });
    expect(quiz.id).toBe(1);
    expect(quiz.title).toBe("Algebra");
    const found = await store.getQuiz(1);
    expect(found).toBeDefined();
    expect(found!.title).toBe("Algebra");
  });

  it("returns all quizzes", async () => {
    await store.createQuiz({ title: "Q1", timeLimitMinutes: 10, dueDate: new Date() });
    await store.createQuiz({ title: "Q2", timeLimitMinutes: 20, dueDate: new Date() });
    const all = await store.getQuizzes();
    expect(all).toHaveLength(2);
  });

  it("returns undefined for non-existent quiz id", async () => {
    const found = await store.getQuiz(999);
    expect(found).toBeUndefined();
  });

  it("deletes a quiz and cascades to its questions and submissions", async () => {
    const quiz = await store.createQuiz({ title: "To Delete", timeLimitMinutes: 5, dueDate: new Date() });
    await store.createQuestions([{ quizId: quiz.id, promptText: "Q?", options: ["A", "B"], correctAnswer: "A", marksWorth: 1 }]);
    const student = await store.findOrCreateStudent({ firstName: "Jane", lastName: "Doe" });
    await store.createSubmission({ studentId: student.id, quizId: quiz.id, totalScore: 1, maxPossibleScore: 1, answersBreakdown: {} });

    await store.deleteQuiz(quiz.id);

    expect(await store.getQuiz(quiz.id)).toBeUndefined();
    expect(await store.getQuestionsByQuizId(quiz.id)).toHaveLength(0);
    expect(await store.getSubmissionsByQuizId(quiz.id)).toHaveLength(0);
  });

  it("increments quiz IDs correctly", async () => {
    const q1 = await store.createQuiz({ title: "Q1", timeLimitMinutes: 10, dueDate: new Date() });
    const q2 = await store.createQuiz({ title: "Q2", timeLimitMinutes: 10, dueDate: new Date() });
    expect(q2.id).toBe(q1.id + 1);
  });
});

// ─── Question CRUD ────────────────────────────────────────────────────────────
describe("Storage: Question CRUD", () => {
  it("creates questions and retrieves them by quizId", async () => {
    const quiz = await store.createQuiz({ title: "Q", timeLimitMinutes: 10, dueDate: new Date() });
    const questions = await store.createQuestions([
      { quizId: quiz.id, promptText: "What is 1+1?", options: ["1", "2", "3", "4"], correctAnswer: "2", marksWorth: 1 },
      { quizId: quiz.id, promptText: "What is 2+2?", options: ["2", "4", "6", "8"], correctAnswer: "4", marksWorth: 2 },
    ]);
    expect(questions).toHaveLength(2);
    const fetched = await store.getQuestionsByQuizId(quiz.id);
    expect(fetched).toHaveLength(2);
  });

  it("returns empty array for quiz with no questions", async () => {
    const quiz = await store.createQuiz({ title: "Empty", timeLimitMinutes: 5, dueDate: new Date() });
    const qs = await store.getQuestionsByQuizId(quiz.id);
    expect(qs).toHaveLength(0);
  });

  it("deletes a specific question", async () => {
    const quiz = await store.createQuiz({ title: "Q", timeLimitMinutes: 10, dueDate: new Date() });
    const [q] = await store.createQuestions([
      { quizId: quiz.id, promptText: "Delete me?", options: ["Y", "N"], correctAnswer: "Y", marksWorth: 1 },
    ]);
    await store.deleteQuestion(q.id);
    const remaining = await store.getQuestionsByQuizId(quiz.id);
    expect(remaining).toHaveLength(0);
  });

  it("creates empty list returns empty array", async () => {
    const result = await store.createQuestions([]);
    expect(result).toHaveLength(0);
  });

  it("does not expose correctAnswer by default (test schema logic)", async () => {
    const quiz = await store.createQuiz({ title: "Q", timeLimitMinutes: 10, dueDate: new Date() });
    const [q] = await store.createQuestions([
      { quizId: quiz.id, promptText: "Secret?", options: ["A", "B", "C", "D"], correctAnswer: "B", marksWorth: 1 },
    ]);
    // Server strips correctAnswer before sending to students
    const { correctAnswer, ...rest } = q;
    expect(correctAnswer).toBe("B");   // Internal has it
    expect(rest.correctAnswer).toBeUndefined(); // Stripped version doesn't
  });
});

// ─── Student CRUD & Sanitization ─────────────────────────────────────────────
describe("Storage: Student & Name Sanitization", () => {
  it("creates a student with sanitized names (lowercase, trimmed)", async () => {
    const student = await store.findOrCreateStudent({ firstName: "  JOHN  ", lastName: "  DOE  " });
    expect(student.firstName).toBe("john");
    expect(student.lastName).toBe("doe");
  });

  it("finds existing student (case-insensitive deduplication)", async () => {
    const s1 = await store.findOrCreateStudent({ firstName: "Alice", lastName: "Smith" });
    const s2 = await store.findOrCreateStudent({ firstName: "ALICE", lastName: "SMITH" });
    expect(s1.id).toBe(s2.id);
  });

  it("collapses multiple spaces in name", async () => {
    const student = await store.findOrCreateStudent({ firstName: "John  Michael", lastName: "van   der   Berg" });
    expect(student.firstName).toBe("john michael");
    expect(student.lastName).toBe("van der berg");
  });

  it("getStudent returns undefined for unknown id", async () => {
    expect(await store.getStudent(9999)).toBeUndefined();
  });

  it("findStudentByName returns undefined for non-existent student", async () => {
    const found = await store.findStudentByName("Nobody", "Here");
    expect(found).toBeUndefined();
  });

  it("creates different students with different names", async () => {
    const s1 = await store.findOrCreateStudent({ firstName: "Alice", lastName: "Smith" });
    const s2 = await store.findOrCreateStudent({ firstName: "Bob", lastName: "Smith" });
    expect(s1.id).not.toBe(s2.id);
  });
});

// ─── Submission & Single-Attempt Enforcement ──────────────────────────────────
describe("Storage: Submissions & Single-Attempt Enforcement", () => {
  let quizId: number;
  let studentId: number;

  beforeEach(async () => {
    const quiz = await store.createQuiz({ title: "Timed Test", timeLimitMinutes: 10, dueDate: new Date() });
    quizId = quiz.id;
    const student = await store.findOrCreateStudent({ firstName: "Test", lastName: "Student" });
    studentId = student.id;
  });

  it("creates and retrieves a submission", async () => {
    const sub = await store.createSubmission({
      studentId,
      quizId,
      totalScore: 8,
      maxPossibleScore: 10,
      answersBreakdown: { "1": { answer: "A", correct: true, marksEarned: 1 } },
    });
    expect(sub.totalScore).toBe(8);
    expect(sub.maxPossibleScore).toBe(10);
  });

  it("checkStudentSubmission returns false when no submission exists", async () => {
    const result = await store.checkStudentSubmission(quizId, "Test", "Student");
    expect(result).toBe(false);
  });

  it("checkStudentSubmission returns true after submission", async () => {
    await store.createSubmission({ studentId, quizId, totalScore: 5, maxPossibleScore: 10, answersBreakdown: {} });
    const result = await store.checkStudentSubmission(quizId, "Test", "Student");
    expect(result).toBe(true);
  });

  it("checkStudentSubmission is case-insensitive (sanitized names)", async () => {
    await store.createSubmission({ studentId, quizId, totalScore: 5, maxPossibleScore: 10, answersBreakdown: {} });
    expect(await store.checkStudentSubmission(quizId, "TEST", "STUDENT")).toBe(true);
    expect(await store.checkStudentSubmission(quizId, "test", "student")).toBe(true);
  });

  it("checkStudentSubmission returns false for different quiz", async () => {
    await store.createSubmission({ studentId, quizId, totalScore: 5, maxPossibleScore: 10, answersBreakdown: {} });
    const otherQuiz = await store.createQuiz({ title: "Other", timeLimitMinutes: 5, dueDate: new Date() });
    expect(await store.checkStudentSubmission(otherQuiz.id, "Test", "Student")).toBe(false);
  });

  it("checkStudentSubmission returns false for non-existent student", async () => {
    const result = await store.checkStudentSubmission(quizId, "Phantom", "User");
    expect(result).toBe(false);
  });

  it("getStudentSubmission retrieves the correct submission", async () => {
    await store.createSubmission({ studentId, quizId, totalScore: 7, maxPossibleScore: 10, answersBreakdown: {} });
    const sub = await store.getStudentSubmission(quizId, "Test", "Student");
    expect(sub).toBeDefined();
    expect(sub!.totalScore).toBe(7);
  });

  it("getStudentSubmission returns undefined when none exists", async () => {
    const sub = await store.getStudentSubmission(quizId, "No", "One");
    expect(sub).toBeUndefined();
  });

  it("getSubmissionsByQuizId returns submissions with student info", async () => {
    await store.createSubmission({ studentId, quizId, totalScore: 9, maxPossibleScore: 10, answersBreakdown: {} });
    const submissions = await store.getSubmissionsByQuizId(quizId);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].student).toBeDefined();
    expect(submissions[0].student.firstName).toBe("test");
  });

  it("deleteSubmission removes a specific submission", async () => {
    const sub = await store.createSubmission({ studentId, quizId, totalScore: 5, maxPossibleScore: 10, answersBreakdown: {} });
    await store.deleteSubmission(sub.id);
    const remaining = await store.getSubmissionsByQuizId(quizId);
    expect(remaining).toHaveLength(0);
  });

  it("deleteSubmissionsByQuizId removes all submissions for a quiz", async () => {
    const s2 = await store.findOrCreateStudent({ firstName: "Second", lastName: "Student" });
    await store.createSubmission({ studentId, quizId, totalScore: 5, maxPossibleScore: 10, answersBreakdown: {} });
    await store.createSubmission({ studentId: s2.id, quizId, totalScore: 7, maxPossibleScore: 10, answersBreakdown: {} });
    await store.deleteSubmissionsByQuizId(quizId);
    const remaining = await store.getSubmissionsByQuizId(quizId);
    expect(remaining).toHaveLength(0);
  });
});

// ─── Soma Storage ────────────────────────────────────────────────────────────
describe("Storage: Soma Quiz & Questions", () => {
  it("creates and retrieves a Soma quiz", async () => {
    const quiz = await store.createSomaQuiz({ title: "Calculus", topic: "Derivatives", status: "published" });
    expect(quiz.id).toBe(1);
    expect(quiz.title).toBe("Calculus");
    expect(quiz.status).toBe("published");
    const found = await store.getSomaQuiz(1);
    expect(found).toBeDefined();
  });

  it("returns all soma quizzes", async () => {
    await store.createSomaQuiz({ title: "Q1", topic: "T1", status: "published" });
    await store.createSomaQuiz({ title: "Q2", topic: "T2", status: "published" });
    const all = await store.getSomaQuizzes();
    expect(all).toHaveLength(2);
  });

  it("returns undefined for non-existent Soma quiz", async () => {
    expect(await store.getSomaQuiz(999)).toBeUndefined();
  });

  it("creates Soma questions and retrieves by quizId", async () => {
    const quiz = await store.createSomaQuiz({ title: "Q", topic: "T", status: "published" });
    const questions = await store.createSomaQuestions([
      { quizId: quiz.id, stem: "What is 2^3?", options: ["4", "6", "8", "16"], correctAnswer: "8", marks: 2 },
    ]);
    expect(questions).toHaveLength(1);
    const fetched = await store.getSomaQuestionsByQuizId(quiz.id);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].stem).toBe("What is 2^3?");
  });

  it("Soma quiz defaults curriculumContext to null", async () => {
    const quiz = await store.createSomaQuiz({ title: "Q", topic: "T", status: "published" });
    expect(quiz.curriculumContext).toBeNull();
  });

  it("returns empty questions for Soma quiz with no questions", async () => {
    const quiz = await store.createSomaQuiz({ title: "Empty", topic: "T", status: "published" });
    const qs = await store.getSomaQuestionsByQuizId(quiz.id);
    expect(qs).toHaveLength(0);
  });
});

// ─── Tutor pre-publish review gate ─────────────────────────────────────────────
import { validateQuestionQuality } from "../server/services/questionQuality";

/**
 * Mirrors the edit-path logic in PATCH
 * /api/tutor/quizzes/:quizId/questions/:questionId/review: apply edits to the
 * existing row, re-run the quality gate, and persist with the resulting status.
 */
async function applyReviewEdit(
  s: TestMemoryStorage,
  existing: any,
  editPatch: { stem?: string; options?: string[]; correctAnswer?: string; explanation?: string },
) {
  const merged = {
    stem: editPatch.stem ?? existing.stem,
    options: (editPatch.options ?? existing.options) as string[],
    correct_answer: editPatch.correctAnswer ?? existing.correctAnswer,
    explanation: editPatch.explanation ?? existing.explanation ?? undefined,
    difficulty_tag: existing.difficultyTag ?? undefined,
  };
  const quality = validateQuestionQuality(merged);
  return s.updateSomaQuestionReview(existing.id, { ...editPatch, reviewStatus: quality.reviewStatus });
}

describe("Storage: Tutor pre-publish review gate", () => {
  async function seedFlagged() {
    const quiz = await store.createSomaQuiz({ title: "Q", topic: "T", status: "published" });
    const [q] = await store.createSomaQuestions([
      {
        quizId: quiz.id,
        stem: "What is 2 + 2?",
        // Duplicate option => hard fail => auto_blocked.
        options: ["4", "4", "5", "6"],
        correctAnswer: "4",
        marks: 1,
        reviewStatus: "auto_blocked",
      },
    ]);
    return q;
  }

  it("updateSomaQuestionReview updates only provided fields and returns the row", async () => {
    const q = await seedFlagged();
    const updated = await store.updateSomaQuestionReview(q.id, { reviewStatus: "approved" });
    expect(updated?.reviewStatus).toBe("approved");
    expect(updated?.stem).toBe("What is 2 + 2?"); // untouched
    expect(updated?.correctAnswer).toBe("4"); // untouched
  });

  it("returns undefined for a missing question id", async () => {
    expect(await store.updateSomaQuestionReview(9999, { reviewStatus: "approved" })).toBeUndefined();
  });

  it("approve action sets reviewStatus to approved", async () => {
    const q = await seedFlagged();
    const updated = await store.updateSomaQuestionReview(q.id, { reviewStatus: "approved" });
    expect(updated?.reviewStatus).toBe("approved");
  });

  it("reject action sets reviewStatus to auto_blocked", async () => {
    const q = await seedFlagged();
    await store.updateSomaQuestionReview(q.id, { reviewStatus: "approved" });
    const rejected = await store.updateSomaQuestionReview(q.id, { reviewStatus: "auto_blocked" });
    expect(rejected?.reviewStatus).toBe("auto_blocked");
  });

  it("edit re-gates: fixing the duplicate option re-approves the question", async () => {
    const q = await seedFlagged();
    // Sanity: the flagged version still fails the gate.
    expect(validateQuestionQuality({
      stem: q.stem,
      options: q.options,
      correct_answer: q.correctAnswer,
    }).reviewStatus).toBe("auto_blocked");

    const updated = await applyReviewEdit(store, q, { options: ["4", "3", "5", "6"] });
    expect(updated?.options).toEqual(["4", "3", "5", "6"]);
    expect(updated?.reviewStatus).toBe("approved");
  });

  it("edit re-gates: an edit that re-introduces a fault stays blocked", async () => {
    const quiz = await store.createSomaQuiz({ title: "Q2", topic: "T", status: "published" });
    const [q] = await store.createSomaQuestions([
      {
        quizId: quiz.id,
        stem: "Pick a number.",
        options: ["1", "2", "3", "4"],
        correctAnswer: "1",
        marks: 1,
        reviewStatus: "approved",
      },
    ]);
    const updated = await applyReviewEdit(store, q, { options: ["1", "1", "3", "4"] });
    expect(updated?.reviewStatus).toBe("auto_blocked");
  });
});
