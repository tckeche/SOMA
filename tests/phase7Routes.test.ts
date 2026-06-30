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
const TUTOR_A = "77777777-1111-4111-8111-111111111111";
const TUTOR_B = "77777777-2222-4222-8222-222222222222";
const STUDENT = "77777777-3333-4333-8333-333333333333";
let request: supertest.SuperTest<supertest.Test>;
let tutorAToken: string;
let tutorBToken: string;
let studentToken: string;

function token(id: string, email: string) { return jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" }); }
async function sync(id: string, email: string, role: string) { const res = await request.post("/api/auth/sync").send({ id, email, user_metadata: { requested_role: role } }); expect(res.status).toBe(200); }
async function createQuiz(title = "Phase 7 Quiz") {
  const res = await request.post("/api/tutor/quizzes").set("Authorization", `Bearer ${tutorAToken}`).send({ title, timeLimitMinutes: 30, format: "mcq", syllabus: "Cambridge:9709" });
  expect(res.status).toBe(200);
  return res.body.id as number;
}
function mcq(stem: string, overrides: Record<string, unknown> = {}) {
  return { stem, options: ["1", "2", "3", "4"], correctAnswer: "4", explanation: "2 + 2 equals 4.", marks: 1, questionType: "multiple_choice", ...overrides };
}
async function addQuestions(quizId: number, questions = [mcq("What is 2 + 2?")]) {
  const res = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions });
  expect(res.status).toBe(200);
  return res.body as Array<{ id: number; correctAnswer?: string }>;
}
function errorMessage(body: any) { return body?.error?.message ?? body?.message; }

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  await registerRoutes(createServer(app), app);
  request = supertest(app);
  await sync(TUTOR_A, "phase7-a@melaniacalvin.com", "tutor");
  await sync(TUTOR_B, "phase7-b@melaniacalvin.com", "tutor");
  await sync(STUDENT, "phase7-student@example.com", "student");
  tutorAToken = token(TUTOR_A, "phase7-a@melaniacalvin.com");
  tutorBToken = token(TUTOR_B, "phase7-b@melaniacalvin.com");
  studentToken = token(STUDENT, "phase7-student@example.com");
});

describe("phase 7 question deletion route", () => {
  it("lets a tutor delete an owned question and preserves detail/answer-key behaviour for remaining questions", async () => {
    const quizId = await createQuiz();
    const [first, second] = await addQuestions(quizId, [mcq("Delete me"), mcq("Keep me")]);

    const deleted = await request.delete(`/api/tutor/questions/${first.id}`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ success: true });

    const detail = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(detail.status).toBe(200);
    const ids = detail.body.questions.map((question: any) => question.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
    expect(detail.body.questions.find((question: any) => question.id === second.id)).toHaveProperty("correctAnswer", "4");
  });

  it("denies deletion when the authenticated tutor does not own the parent quiz", async () => {
    const quizId = await createQuiz("Phase 7 Ownership Quiz");
    const [question] = await addQuestions(quizId);

    const denied = await request.delete(`/api/tutor/questions/${question.id}`).set("Authorization", `Bearer ${tutorBToken}`);
    expect(denied.status).toBe(403);
    expect(errorMessage(denied.body)).toBe("Access denied");

    const detail = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.questions.map((q: any) => q.id)).toContain(question.id);
  });

  it("preserves invalid and missing question error shapes", async () => {
    const invalid = await request.delete("/api/tutor/questions/not-a-number").set("Authorization", `Bearer ${tutorAToken}`);
    expect(invalid.status).toBe(400);
    expect(errorMessage(invalid.body)).toBe("Invalid question ID");

    const missing = await request.delete("/api/tutor/questions/99999999").set("Authorization", `Bearer ${tutorAToken}`);
    expect(missing.status).toBe(404);
    expect(errorMessage(missing.body)).toBe("Question not found");
  });

  it("keeps student pre-submission questions sanitized after deletion migration", async () => {
    const quizId = await createQuiz("Phase 7 Student Safety Quiz");
    await addQuestions(quizId, [mcq("Student visible question")]);
    await storage.adoptStudent(TUTOR_A, STUDENT);
    await request.post(`/api/tutor/quizzes/${quizId}/assign`).set("Authorization", `Bearer ${tutorAToken}`).send({ studentIds: [STUDENT] });

    const studentView = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${studentToken}`);
    expect(studentView.status).toBe(200);
    expect(JSON.stringify(studentView.body)).not.toContain("correctAnswer");
    expect(JSON.stringify(studentView.body)).not.toContain("optionRationales");
  });

  it("discovers questionManagement and removes the migrated delete handler from the monolith", async () => {
    const modules = await discoverDomainModules();
    expect(modules.map((module) => module.name)).toContain("questionManagement");
    const legacyRoutes = readFileSync("server/routes.ts", "utf8");
    expect(legacyRoutes).not.toContain('app.delete("/api/tutor/questions/:questionId"');
  });
});
