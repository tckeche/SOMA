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
const TUTOR_A = "66666666-1111-4111-8111-111111111111";
const TUTOR_B = "66666666-2222-4222-8222-222222222222";
const STUDENT = "66666666-3333-4333-8333-333333333333";
let request: supertest.SuperTest<supertest.Test>;
let tutorAToken: string;
let tutorBToken: string;
let studentToken: string;

function token(id: string, email: string) { return jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" }); }
async function sync(id: string, email: string, role: string) { const res = await request.post("/api/auth/sync").send({ id, email, user_metadata: { requested_role: role } }); expect(res.status).toBe(200); }
async function createQuiz(title = "Phase 6 Quiz") {
  const res = await request.post("/api/tutor/quizzes").set("Authorization", `Bearer ${tutorAToken}`).send({ title, timeLimitMinutes: 30, format: "mcq", syllabus: "Cambridge:9709" });
  expect(res.status).toBe(200);
  return res.body.id as number;
}
function mcq(overrides: Record<string, unknown> = {}) {
  return { stem: "What is 2 + 2?", options: ["1", "2", "3", "4"], correctAnswer: "4", explanation: "2 + 2 equals 4.", marks: 1, questionType: "multiple_choice", ...overrides };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  await registerRoutes(createServer(app), app);
  request = supertest(app);
  await sync(TUTOR_A, "phase6-a@melaniacalvin.com", "tutor");
  await sync(TUTOR_B, "phase6-b@melaniacalvin.com", "tutor");
  await sync(STUDENT, "phase6-student@example.com", "student");
  tutorAToken = token(TUTOR_A, "phase6-a@melaniacalvin.com");
  tutorBToken = token(TUTOR_B, "phase6-b@melaniacalvin.com");
  studentToken = token(STUDENT, "phase6-student@example.com");
});

describe("phase 6 question management route", () => {
  it("adds an owned MCQ question and preserves attribution fields for tutor detail only", async () => {
    const quizId = await createQuiz();
    const generationMeta = { makerModel: "manual", promptVersion: "phase6:test" };
    const optionRationales = [
      { option: "1", isCorrect: false, rationale: "too low", misconceptionId: 101 },
      { option: "2", isCorrect: false, rationale: "too low", misconceptionId: 102 },
      { option: "3", isCorrect: false, rationale: "near miss", misconceptionId: 103 },
      { option: "4", isCorrect: true, rationale: "correct", misconceptionId: null },
    ];
    const res = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ targetMisconceptionIds: [101, 102], optionRationales, subtopicId: 7, learningRequirementId: 9, commandWord: "calculate", assessmentObjective: "AO1", generationMeta, reviewStatus: "needs_review", topicTag: "Algebra", subtopicTag: "Arithmetic" })] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ correctAnswer: "4", targetMisconceptionIds: [101, 102], subtopicId: 7, learningRequirementId: 9, commandWord: "calculate", assessmentObjective: "AO1", generationMeta, reviewStatus: "needs_review", topicTag: "Algebra", subtopicTag: "Arithmetic" });
    expect(res.body[0].optionRationales).toEqual(optionRationales);

    await storage.adoptStudent(TUTOR_A, STUDENT);
    await request.post(`/api/tutor/quizzes/${quizId}/assign`).set("Authorization", `Bearer ${tutorAToken}`).send({ studentIds: [STUDENT] });
    const studentView = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${studentToken}`);
    expect(studentView.status).toBe(200);
    expect(JSON.stringify(studentView.body)).not.toContain("correctAnswer");
    expect(JSON.stringify(studentView.body)).not.toContain("optionRationales");
  });

  it("rejects non-owner, missing quiz, invalid quiz id, and question cap violations", async () => {
    const quizId = await createQuiz("Phase 6 Guard Quiz");
    const denied = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorBToken}`).send({ questions: [mcq()] });
    expect(denied.status).toBe(403);

    const missing = await request.post("/api/tutor/quizzes/999999/questions").set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq()] });
    expect(missing.status).toBe(404);

    const invalid = await request.post("/api/tutor/quizzes/not-a-number/questions").set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq()] });
    expect(invalid.status).toBe(400);

    const capQuiz = await createQuiz("Phase 6 Cap Quiz");
    const fifteen = Array.from({ length: 15 }, (_, i) => mcq({ stem: `Question ${i}?` }));
    expect((await request.post(`/api/tutor/quizzes/${capQuiz}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: fifteen })).status).toBe(200);
    const over = await request.post(`/api/tutor/quizzes/${capQuiz}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ stem: "Too many?" })] });
    expect(over.status).toBe(400);
    expect(JSON.stringify(over.body)).toContain("at most 15 questions");
  });

  it("validates graph, MCQ, and structured question requirements", async () => {
    const quizId = await createQuiz("Phase 6 Validation Quiz");
    const badOptions = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ options: ["1", "2", "3"] })] });
    expect(badOptions.status).toBe(400);

    const invalidGraph = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ questionType: "graph", graphSpec: { xRange: [0, 1] } })] });
    expect(invalidGraph.status).toBe(400);

    const structuredMissingScheme = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ questionType: "structured", options: [], markScheme: "" })] });
    expect(structuredMissingScheme.status).toBe(400);

    const validGraph = await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ stem: "Sketch y=x", questionType: "graph", graphSpec: { equation: "x", xRange: [0, 2], yRange: [0, 2], axisLabels: { x: "x", y: "y" } } })] });
    expect(validGraph.status).toBe(200);
    expect(validGraph.body[0].questionType).toBe("graph");
    expect(validGraph.body[0].graphSpec).toBeTruthy();
  });

  it("discovers the phase 6 module and removes the migrated handler from the monolith", async () => {
    const modules = await discoverDomainModules();
    expect(modules.map((m) => m.name)).toContain("questionManagement");
    const legacyRoutes = readFileSync("server/routes.ts", "utf8");
    expect(legacyRoutes).not.toContain('app.post("/api/tutor/quizzes/:quizId/questions"');
  });
});
