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
vi.mock("../server/services/catalogueInventory", () => ({ listAllowedTopicsForSyllabusCode: vi.fn().mockResolvedValue([]) }));

import { registerRoutes } from "../server/routes";
import { discoverDomainModules } from "../server/modules/routerLoader";
import { storage } from "../server/storage";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing-only-32chars";
const TUTOR_A = "55555555-1111-4111-8111-111111111111";
const TUTOR_B = "55555555-2222-4222-8222-222222222222";
const STUDENT = "55555555-3333-4333-8333-333333333333";
let request: supertest.SuperTest<supertest.Test>;
let tutorAToken: string;
let tutorBToken: string;
let studentToken: string;
let quizId: number;

function token(id: string, email: string) { return jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" }); }
async function sync(id: string, email: string, role: string) { const res = await request.post("/api/auth/sync").send({ id, email, user_metadata: { requested_role: role } }); expect(res.status).toBe(200); }
function mcq(overrides: Record<string, unknown> = {}) { return { draftId: `d-${Math.random()}`, stem: "What is 2 + 2?", options: ["1", "2", "3", "4"], correctAnswer: "4", explanation: "2 + 2 equals 4.", marks: 1, questionType: "multiple_choice", ...overrides }; }

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  await registerRoutes(createServer(app), app);
  request = supertest(app);
  await sync(TUTOR_A, "phase5-a@melaniacalvin.com", "tutor");
  await sync(TUTOR_B, "phase5-b@melaniacalvin.com", "tutor");
  await sync(STUDENT, "phase5-student@example.com", "student");
  tutorAToken = token(TUTOR_A, "phase5-a@melaniacalvin.com");
  tutorBToken = token(TUTOR_B, "phase5-b@melaniacalvin.com");
  studentToken = token(STUDENT, "phase5-student@example.com");
  const res = await request.post("/api/tutor/quizzes").set("Authorization", `Bearer ${tutorAToken}`).send({ title: "Phase 5 Quiz", timeLimitMinutes: 30, format: "mcq", syllabus: "Cambridge:9709" });
  expect(res.status).toBe(200);
  quizId = res.body.id;
});

describe("phase 5 quiz drafts and publish", () => {
  it("saves and fetches an owned draft and blocks another tutor", async () => {
    const questions = [mcq()];
    const save = await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions });
    expect(save.status).toBe(200);
    expect(save.body).toMatchObject({ quizId });
    expect(save.body.questions).toHaveLength(1);
    expect(save.body.updatedAt).toBeTruthy();

    const fetch = await request.get(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(fetch.status).toBe(200);
    expect(fetch.body.questions).toHaveLength(1);

    const deniedSave = await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorBToken}`).send({ questions });
    expect(deniedSave.status).toBe(403);
    const deniedFetch = await request.get(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorBToken}`);
    expect(deniedFetch.status).toBe(403);
  });

  it("enforces publish gates and preserves attribution fields", async () => {
    const otherPublish = await request.post(`/api/tutor/quizzes/${quizId}/publish`).set("Authorization", `Bearer ${tutorBToken}`).send({ questions: [mcq()] });
    expect(otherPublish.status).toBe(403);

    const emptyQuiz = await request.post("/api/tutor/quizzes").set("Authorization", `Bearer ${tutorAToken}`).send({ title: "Empty", timeLimitMinutes: 30, format: "mcq" });
    const empty = await request.post(`/api/tutor/quizzes/${emptyQuiz.body.id}/publish`).set("Authorization", `Bearer ${tutorAToken}`).send({});
    expect(empty.status).toBe(400);

    const tooMany = Array.from({ length: 16 }, (_, i) => mcq({ stem: `Question ${i}` }));
    const cap = await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: tooMany });
    expect(cap.status).toBe(400);

    const structured = await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ questionType: "structured", options: [], correctAnswer: "", markScheme: "" })] });
    expect(structured.status).toBe(200);
    const badStructured = await request.post(`/api/tutor/quizzes/${quizId}/publish`).set("Authorization", `Bearer ${tutorAToken}`).send({});
    expect(badStructured.status).toBe(400);

    await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [mcq({ options: ["1", "2", "3"] })] });
    const badOptions = await request.post(`/api/tutor/quizzes/${quizId}/publish`).set("Authorization", `Bearer ${tutorAToken}`).send({});
    expect(badOptions.status).toBe(400);

    const graph = mcq({ questionType: "graph", graphSpec: { nope: true } });
    await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [graph] });
    const badGraph = await request.post(`/api/tutor/quizzes/${quizId}/publish`).set("Authorization", `Bearer ${tutorAToken}`).send({});
    expect(badGraph.status).toBe(400);

    const rich = mcq({ targetMisconceptionIds: [101, 102], optionRationales: [{ option: "1", isCorrect: false, rationale: "low", misconceptionId: 101 }], subtopicId: 7, learningRequirementId: 9, commandWord: "calculate", assessmentObjective: "AO1", generationMeta: { makerModel: "test-maker" }, difficultyTag: "medium" });
    await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`).send({ questions: [rich] });
    const published = await request.post(`/api/tutor/quizzes/${quizId}/publish`).set("Authorization", `Bearer ${tutorAToken}`).send({});
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ quizId, publishedCount: 1 });
    expect(published.body.reviewSummary).toMatchObject({ total: 1, servable: 1 });
    expect(published.body.questions[0]).toMatchObject({ targetMisconceptionIds: [101, 102], subtopicId: 7, learningRequirementId: 9, commandWord: "calculate", assessmentObjective: "AO1" });
    expect(published.body.questions[0].optionRationales?.[0].misconceptionId).toBe(101);
    expect(published.body.questions[0].generationMeta).toMatchObject({ makerModel: "test-maker" });

    const cleared = await request.get(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(cleared.body.questions).toHaveLength(0);
  });

  it("allows PDF assessments to publish with zero questions", async () => {
    const pdfQuiz = await request.post("/api/tutor/quizzes").set("Authorization", `Bearer ${tutorAToken}`).send({ title: "PDF", timeLimitMinutes: 30, format: "pdf" });
    const res = await request.post(`/api/tutor/quizzes/${pdfQuiz.body.id}/publish`).set("Authorization", `Bearer ${tutorAToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ quizId: pdfQuiz.body.id, publishedCount: 0, questions: [], format: "pdf" });
  });

  it("keeps answer-key safety and confirms route migration", async () => {
    await storage.adoptStudent(TUTOR_A, STUDENT);
    await request.post(`/api/tutor/quizzes/${quizId}/assign`).set("Authorization", `Bearer ${tutorAToken}`).send({ studentIds: [STUDENT] });
    const studentQuestions = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${studentToken}`);
    expect(JSON.stringify(studentQuestions.body)).not.toContain("correctAnswer");
    const tutorDetail = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(tutorDetail.body.questions[0].correctAnswer).toBe("4");

    const modules = await discoverDomainModules();
    expect(modules.map((m) => m.name)).toEqual(expect.arrayContaining(["quizDrafts", "quizPublish"]));
    const legacyRoutes = readFileSync("server/routes.ts", "utf8");
    expect(legacyRoutes).not.toContain('/api/tutor/quizzes/:quizId/draft');
    expect(legacyRoutes).not.toContain('/api/tutor/quizzes/:quizId/publish');
  });
});
