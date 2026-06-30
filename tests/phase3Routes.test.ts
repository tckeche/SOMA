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
const TUTOR_A = "33333333-1111-4111-8111-111111111111";
const TUTOR_B = "33333333-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";

let request: supertest.SuperTest<supertest.Test>;
let server: ReturnType<typeof createServer>;
let tutorAToken: string;
let tutorBToken: string;
let studentToken: string;
let quizId: number;
let questionId: number;

function token(userId: string, email: string) {
  return jwt.sign({ sub: userId, email, role: "authenticated" }, SECRET, { expiresIn: "1h" });
}

async function syncUser(userId: string, email: string, requestedRole: string) {
  const res = await request.post("/api/auth/sync").send({ id: userId, email, user_metadata: { requested_role: requestedRole } });
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = createServer(app);
  await registerRoutes(server, app);
  request = supertest(app);

  await syncUser(TUTOR_A, "phase3-a@melaniacalvin.com", "tutor");
  await syncUser(TUTOR_B, "phase3-b@melaniacalvin.com", "tutor");
  await syncUser(STUDENT, "phase3-student@example.com", "student");
  tutorAToken = token(TUTOR_A, "phase3-a@melaniacalvin.com");
  tutorBToken = token(TUTOR_B, "phase3-b@melaniacalvin.com");
  studentToken = token(STUDENT, "phase3-student@example.com");

  const created = await request
    .post("/api/tutor/quizzes")
    .set("Authorization", `Bearer ${tutorAToken}`)
    .send({ title: "Phase 3 Owned Quiz", timeLimitMinutes: 30, format: "mcq", subject: "Maths", topic: "Algebra" });
  expect(created.status).toBe(200);
  quizId = created.body.id;

  const questions = await request
    .post(`/api/tutor/quizzes/${quizId}/questions`)
    .set("Authorization", `Bearer ${tutorAToken}`)
    .send({ questions: [{ stem: "2+2?", options: ["3", "4", "5", "6"], correct_answer: "4", marks: 1 }] });
  expect(questions.status).toBe(200);

  const detail = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorAToken}`);
  questionId = detail.body.questions[0].id;
});

describe("phase 3 migrated tutor assessment routes", () => {
  it("blocks another tutor from reading quiz detail while owner sees answer keys", async () => {
    const denied = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorBToken}`);
    expect([403, 404]).toContain(denied.status);

    const owned = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(owned.status).toBe(200);
    expect(owned.body.questions[0].correctAnswer).toBe("4");
  });

  it("keeps student quiz-taking response sanitized before submission", async () => {
    await storage.adoptStudent(TUTOR_A, STUDENT);
    await request.post(`/api/tutor/quizzes/${quizId}/assign`).set("Authorization", `Bearer ${tutorAToken}`).send({ studentIds: [STUDENT] });

    const res = await request.get(`/api/soma/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("correctAnswer");
    expect(JSON.stringify(res.body)).not.toContain("correct_answer");
  });

  it("blocks another tutor from archive, delete, assignments, and reports", async () => {
    expect([403, 404]).toContain((await request.patch(`/api/tutor/quizzes/${quizId}/archive`).set("Authorization", `Bearer ${tutorBToken}`).send({ archived: true })).status);
    expect([403, 404]).toContain((await request.delete(`/api/tutor/quizzes/${quizId}`).set("Authorization", `Bearer ${tutorBToken}`)).status);
    expect([403, 404]).toContain((await request.get(`/api/tutor/quizzes/${quizId}/assignments`).set("Authorization", `Bearer ${tutorBToken}`)).status);
    expect([403, 404]).toContain((await request.get(`/api/tutor/quizzes/${quizId}/reports`).set("Authorization", `Bearer ${tutorBToken}`)).status);
  });

  it("validates due dates and preserves deadline extension response shape", async () => {
    const invalid = await request.patch(`/api/tutor/quizzes/${quizId}/due-date`).set("Authorization", `Bearer ${tutorAToken}`).send({ dueDate: "not-a-date" });
    expect(invalid.status).toBe(400);

    const extended = await request.patch(`/api/tutor/quizzes/${quizId}/assignments/extend`).set("Authorization", `Bearer ${tutorAToken}`).send({ hours: 24 });
    expect(extended.status).toBe(200);
    expect(extended.body).toMatchObject({ success: true, updated: 1 });
    expect(extended.body.message).toContain("Extended deadline by 24h");
  });

  it("enforces tutor ownership for flagged question listing and resolution", async () => {
    const flag = await storage.flagQuestion({ studentId: STUDENT, quizId, questionId, reason: "needs review" });

    const nonOwnerList = await request.get(`/api/tutor/flagged-questions?quizId=${quizId}`).set("Authorization", `Bearer ${tutorBToken}`);
    expect(nonOwnerList.status).toBe(200);
    expect(nonOwnerList.body.flags).toHaveLength(0);

    const ownerList = await request.get(`/api/tutor/flagged-questions?quizId=${quizId}&unresolvedOnly=true`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.flags.some((row: any) => row.id === flag.id)).toBe(true);

    const nonOwnerResolve = await request.post(`/api/tutor/flagged-questions/${flag.id}/resolve`).set("Authorization", `Bearer ${tutorBToken}`);
    expect(nonOwnerResolve.status).toBe(404);

    const ownerResolve = await request.post(`/api/tutor/flagged-questions/${flag.id}/resolve`).set("Authorization", `Bearer ${tutorAToken}`);
    expect(ownerResolve.status).toBe(200);
    expect(ownerResolve.body.resolvedAt).not.toBeNull();
  });

  it("discovers phase 3 modules and removes migrated handlers from the monolith", async () => {
    const modules = await discoverDomainModules();
    expect(modules.map((m) => m.name)).toEqual(expect.arrayContaining(["tutorQuizzes", "quizAssignments", "tutorReports", "tutorDashboard", "flaggedQuestions"]));

    const legacyRoutes = readFileSync("server/routes.ts", "utf8");
    expect(legacyRoutes).not.toContain('app.get("/api/tutor/quizzes"');
    expect(legacyRoutes).not.toContain('app.post("/api/tutor/quizzes/:quizId/assign"');
    expect(legacyRoutes).not.toContain('app.get("/api/tutor/quizzes/:quizId/detail"');
    expect(legacyRoutes).not.toContain('app.patch("/api/tutor/quizzes/:quizId/archive"');
    expect(legacyRoutes).not.toContain('app.get("/api/tutor/flagged-questions"');
  });
});
