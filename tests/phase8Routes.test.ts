import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import { createServer } from "http";
import supertest from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../server/db", () => ({ db: null }));
vi.mock("express-rate-limit", () => ({
  default: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  rateLimit: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  ipKeyGenerator: vi.fn((ip: string) => ip),
}));

import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { discoverDomainModules } from "../server/modules/routerLoader";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing-only-32chars";
const TUTOR = "88888888-1111-4111-8111-111111111111";
const OTHER_TUTOR = "88888888-2222-4222-8222-222222222222";
const STUDENT = "88888888-3333-4333-8333-333333333333";
const OTHER_STUDENT = "88888888-4444-4444-8444-444444444444";
let request: supertest.SuperTest<supertest.Test>;
let tutorToken: string;
let otherTutorToken: string;
let studentToken: string;
let otherStudentToken: string;

function token(id: string, email: string) { return jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" }); }
async function sync(id: string, email: string, role: string) { const res = await request.post("/api/auth/sync").send({ id, email, user_metadata: { requested_role: role } }); expect(res.status).toBe(200); }
async function createQuiz(title = "Phase 8 Quiz", format = "mcq") {
  const res = await request.post("/api/tutor/quizzes").set("Authorization", `Bearer ${tutorToken}`).send({ title, timeLimitMinutes: 30, format, syllabus: "Cambridge:9709" });
  expect(res.status).toBe(200);
  return res.body.id as number;
}
async function assign(quizId: number, studentId = STUDENT) {
  const res = await request.post(`/api/tutor/quizzes/${quizId}/assign`).set("Authorization", `Bearer ${tutorToken}`).send({ studentIds: [studentId] });
  expect(res.status).toBe(200);
}
function mcq(stem: string, overrides: Record<string, unknown> = {}) {
  return { stem, options: ["1", "2", "3", "4"], correctAnswer: "4", explanation: "2 + 2 equals 4.", marks: 2, questionType: "multiple_choice", ...overrides };
}
async function addQuestions(quizId: number, questions: Record<string, unknown>[]) {
  const res = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorToken}`).send({ questions });
  expect(res.status).toBe(200);
  return res.body;
}
function errorMessage(body: any) { return body?.error?.message ?? body?.message; }

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  await registerRoutes(createServer(app), app);
  request = supertest(app);
  await sync(TUTOR, "phase8-tutor@melaniacalvin.com", "tutor");
  await sync(OTHER_TUTOR, "phase8-other-tutor@melaniacalvin.com", "tutor");
  await sync(STUDENT, "phase8-student@example.com", "student");
  await sync(OTHER_STUDENT, "phase8-other-student@example.com", "student");
  await storage.adoptStudent(TUTOR, STUDENT);
  await storage.adoptStudent(TUTOR, OTHER_STUDENT);
  tutorToken = token(TUTOR, "phase8-tutor@melaniacalvin.com");
  otherTutorToken = token(OTHER_TUTOR, "phase8-other-tutor@melaniacalvin.com");
  studentToken = token(STUDENT, "phase8-student@example.com");
  otherStudentToken = token(OTHER_STUDENT, "phase8-other-student@example.com");
});

describe("phase 8 student quiz-taking read routes", () => {
  it("lets an assigned student load quiz metadata and a sanitized pre-submission question payload", async () => {
    const quizId = await createQuiz();
    const graphSpec = { equation: "x", xRange: [0, 2], yRange: [0, 2], axisLabels: { x: "x", y: "y" } };
    await addQuestions(quizId, [
      mcq("Visible MCQ", { optionRationales: [{ option: "4", isCorrect: true, rationale: "correct", misconceptionId: null }], targetMisconceptionIds: [101], reviewStatus: "approved" }),
      mcq("Visible graph", { questionType: "graph", graphSpec, reviewStatus: "approved" }),
      mcq("Blocked review item", { reviewStatus: "needs_review" }),
    ]);
    await assign(quizId);

    const quiz = await request.get(`/api/soma/quizzes/${quizId}`).set("Authorization", `Bearer ${studentToken}`);
    expect(quiz.status).toBe(200);
    expect(quiz.body.id).toBe(quizId);

    const questions = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${studentToken}`);
    expect(questions.status).toBe(200);
    expect(questions.body).toHaveLength(2);
    expect(JSON.stringify(questions.body)).not.toContain("correctAnswer");
    expect(JSON.stringify(questions.body)).not.toContain("optionRationales");
    expect(JSON.stringify(questions.body)).not.toContain("targetMisconceptionIds");
    expect(JSON.stringify(questions.body)).not.toContain("reviewStatus");
    expect(questions.body[0]).toMatchObject({ stem: "Visible MCQ", marks: 2, questionType: "multiple_choice" });
    expect(questions.body[0].options).toHaveLength(4);
    expect(questions.body[0].options).toEqual(expect.arrayContaining(["1", "2", "3", "4"]));
    expect(questions.body.find((question: any) => question.questionType === "graph")?.graphSpec).toMatchObject(graphSpec);
  });

  it("blocks unassigned students while preserving invalid, missing, and archived quiz responses", async () => {
    const quizId = await createQuiz("Phase 8 Access Quiz");
    await addQuestions(quizId, [mcq("Access question")]);
    await assign(quizId);

    const unassigned = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${otherStudentToken}`);
    expect(unassigned.status).toBe(403);
    expect(errorMessage(unassigned.body)).toBe("Forbidden: you do not have access to this quiz");

    const invalid = await request.get("/api/soma/quizzes/not-a-number/questions").set("Authorization", `Bearer ${studentToken}`);
    expect(invalid.status).toBe(400);
    expect(errorMessage(invalid.body)).toBe("Invalid quiz ID");

    const missing = await request.get("/api/soma/quizzes/99999999/questions").set("Authorization", `Bearer ${studentToken}`);
    expect(missing.status).toBe(404);
    expect(errorMessage(missing.body)).toBe("Quiz not found");

    const archivedQuizId = await createQuiz("Phase 8 Archived Quiz");
    await assign(archivedQuizId);
    const archived = await request.patch(`/api/tutor/quizzes/${archivedQuizId}/archive`).set("Authorization", `Bearer ${tutorToken}`);
    expect(archived.status).toBe(200);
    const archivedRead = await request.get(`/api/soma/quizzes/${archivedQuizId}`).set("Authorization", `Bearer ${studentToken}`);
    expect(archivedRead.status).toBe(404);
    expect(errorMessage(archivedRead.body)).toBe("Quiz not found");
  });

  it("preserves mixed read access without letting non-owning tutors use the student route", async () => {
    const quizId = await createQuiz("Phase 8 Mixed Access Quiz");
    await addQuestions(quizId, [mcq("Tutor readable question")]);

    const owner = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorToken}`);
    expect(owner.status).toBe(200);
    expect(JSON.stringify(owner.body)).not.toContain("correctAnswer");

    const nonOwner = await request.get(`/api/soma/quizzes/${quizId}`).set("Authorization", `Bearer ${otherTutorToken}`);
    expect(nonOwner.status).toBe(403);
    expect(errorMessage(nonOwner.body)).toBe("Forbidden: you do not have access to this quiz");

    const tutorDetail = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorToken}`);
    expect(tutorDetail.status).toBe(200);
    expect(tutorDetail.body.questions[0]).toHaveProperty("correctAnswer", "4");
  });

  it("preserves PDF quiz read, submission-check, and student attachment visibility without leaking storage paths", async () => {
    const quizId = await createQuiz("Phase 8 PDF Quiz", "pdf");
    await assign(quizId);
    await storage.createAssessmentAttachment({ quizId, filename: "worksheet.pdf", storagePath: `assessments/${quizId}/worksheet.pdf`, mimeType: "application/pdf", sizeBytes: 1234, uploadedBy: TUTOR });

    const quiz = await request.get(`/api/soma/quizzes/${quizId}`).set("Authorization", `Bearer ${studentToken}`);
    expect(quiz.status).toBe(200);
    expect(quiz.body.format).toBe("pdf");

    const questions = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${studentToken}`);
    expect(questions.status).toBe(200);
    expect(questions.body).toEqual([]);

    const submissionCheck = await request.get(`/api/soma/quizzes/${quizId}/check-submission`).set("Authorization", `Bearer ${studentToken}`);
    expect(submissionCheck.status).toBe(200);
    expect(submissionCheck.body).toEqual({ submitted: false });

    const attachments = await request.get(`/api/quizzes/${quizId}/attachments`).set("Authorization", `Bearer ${studentToken}`);
    expect(attachments.status).toBe(200);
    expect(attachments.body).toHaveLength(1);
    expect(attachments.body[0]).toMatchObject({ filename: "worksheet.pdf", mimeType: "application/pdf", sizeBytes: 1234 });
    expect(attachments.body[0]).not.toHaveProperty("storagePath");
    expect(attachments.body[0]).not.toHaveProperty("annotatedStoragePath");
  });

  it("discovers studentQuizTaking and removes migrated read handlers from the monolith", async () => {
    const modules = await discoverDomainModules();
    expect(modules.map((module) => module.name)).toContain("studentQuizTaking");
    const legacyRoutes = readFileSync("server/routes.ts", "utf8");
    expect(legacyRoutes).not.toContain('app.get("/api/soma/quizzes"');
    expect(legacyRoutes).not.toContain('app.get("/api/soma/quizzes/:id"');
    expect(legacyRoutes).not.toContain('app.get("/api/soma/quizzes/:id/questions"');
    expect(legacyRoutes).not.toContain('app.get("/api/soma/quizzes/:id/check-submission"');
  });
});
