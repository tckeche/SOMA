/**
 * TUTOR QUIZ OWNERSHIP / IDOR REGRESSION (SOMA-IDOR).
 *
 * A cluster of tutor quiz endpoints checked only `if (!quiz)` and omitted the
 * `quiz.authorId === tutorId` gate that every sibling route enforces. That let
 * any authenticated tutor read another tutor's answer keys + student roster and
 * delete / overwrite / re-assign their assessments by guessing a numeric quizId.
 *
 * These tests assert that a non-owning tutor (TUTOR_B) is rejected on each
 * previously-vulnerable endpoint, while the owner (TUTOR_A) still succeeds —
 * guarding against both the regression and an over-broad lockout.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import supertest from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../server/db", () => ({ db: null }));
vi.mock("express-rate-limit", () => ({
  default: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  rateLimit: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  ipKeyGenerator: vi.fn().mockReturnValue("test-ip"),
}));

import { registerRoutes } from "../server/routes";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing-only-32chars";
const TUTOR_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TUTOR_B = "bbbbbbbb-2222-2222-2222-222222222222";
const STUDENT = "cccccccc-3333-3333-3333-333333333333";

let app: express.Express;
let httpServer: any;
let request: supertest.SuperTest<supertest.Test>;
let tutorA: string;
let tutorB: string;

function tokenFor(id: string, email: string) {
  return jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" });
}
async function sync(id: string, email: string) {
  await request.post("/api/auth/sync").send({ id, email, user_metadata: {} });
}

beforeAll(async () => {
  app = express();
  app.use(express.json());
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  request = supertest(app);

  await sync(TUTOR_A, "tutora@melaniacalvin.com");
  await sync(TUTOR_B, "tutorb@melaniacalvin.com");
  await sync(STUDENT, "stud@example.com");
  tutorA = tokenFor(TUTOR_A, "tutora@melaniacalvin.com");
  tutorB = tokenFor(TUTOR_B, "tutorb@melaniacalvin.com");
});

afterAll(() => httpServer.close());

async function makeQuizOwnedByA(): Promise<{ quizId: number; questionId: number }> {
  const quizRes = await request
    .post("/api/tutor/quizzes")
    .set("Authorization", `Bearer ${tutorA}`)
    .send({ title: "A's Quiz", timeLimitMinutes: 30, format: "mcq" });
  const quizId = quizRes.body.id;
  await request
    .post(`/api/tutor/quizzes/${quizId}/questions`)
    .set("Authorization", `Bearer ${tutorA}`)
    .send({ questions: [{ stem: "2+2?", options: ["3", "4", "5", "6"], correct_answer: "4", marks: 1 }] });
  const detail = await request
    .get(`/api/tutor/quizzes/${quizId}/detail`)
    .set("Authorization", `Bearer ${tutorA}`);
  const questionId = detail.body.questions?.[0]?.id;
  return { quizId, questionId };
}

describe("tutor quiz ownership — non-owner is blocked (IDOR)", () => {
  it("blocks a non-owning tutor on every previously-vulnerable endpoint", async () => {
    const { quizId, questionId } = await makeQuizOwnedByA();
    expect(typeof quizId).toBe("number");
    expect(typeof questionId).toBe("number");

    const denied = (s: number) => s === 403 || s === 404;

    // Reads that leaked answer keys / roster PII.
    expect(denied((await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorB}`)).status)).toBe(true);
    expect(denied((await request.get(`/api/tutor/quizzes/${quizId}/assignments`).set("Authorization", `Bearer ${tutorB}`)).status)).toBe(true);
    expect(denied((await request.get(`/api/tutor/quizzes/${quizId}/reports`).set("Authorization", `Bearer ${tutorB}`)).status)).toBe(true);

    // Writes that tampered with another tutor's assessment.
    expect(denied((await request.put(`/api/tutor/quizzes/${quizId}`).set("Authorization", `Bearer ${tutorB}`).send({ title: "hijacked" })).status)).toBe(true);
    expect(denied((await request.put(`/api/tutor/quizzes/${quizId}/draft`).set("Authorization", `Bearer ${tutorB}`).send({ questions: [] })).status)).toBe(true);
    expect(denied((await request.post(`/api/tutor/quizzes/${quizId}/publish`).set("Authorization", `Bearer ${tutorB}`).send({ questions: [] })).status)).toBe(true);
    expect(denied((await request.post(`/api/tutor/quizzes/${quizId}/questions`).set("Authorization", `Bearer ${tutorB}`).send({ questions: [{ stem: "x", options: ["1", "2", "3", "4"], correct_answer: "1", marks: 1 }] })).status)).toBe(true);
    expect(denied((await request.delete(`/api/tutor/questions/${questionId}`).set("Authorization", `Bearer ${tutorB}`)).status)).toBe(true);

    // The assign route: B adopts the student, then tries to assign A's quiz.
    await request.post("/api/tutor/students/adopt").set("Authorization", `Bearer ${tutorB}`).send({ studentIds: [STUDENT] });
    expect(denied((await request.post(`/api/tutor/quizzes/${quizId}/assign`).set("Authorization", `Bearer ${tutorB}`).send({ studentIds: [STUDENT] })).status)).toBe(true);

    // Title must be unchanged, question still present — confirms no write landed.
    const after = await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorA}`);
    expect(after.body.title).toBe("A's Quiz");
    expect(after.body.questions).toHaveLength(1);
  });

  it("still lets the owner read and mutate their own quiz (no over-lockout)", async () => {
    const { quizId } = await makeQuizOwnedByA();
    expect((await request.get(`/api/tutor/quizzes/${quizId}/detail`).set("Authorization", `Bearer ${tutorA}`)).status).toBe(200);
    expect((await request.get(`/api/tutor/quizzes/${quizId}/assignments`).set("Authorization", `Bearer ${tutorA}`)).status).toBe(200);
    expect((await request.get(`/api/tutor/quizzes/${quizId}/reports`).set("Authorization", `Bearer ${tutorA}`)).status).toBe(200);
    const renamed = await request.put(`/api/tutor/quizzes/${quizId}`).set("Authorization", `Bearer ${tutorA}`).send({ title: "Renamed" });
    expect(renamed.status).toBe(200);
  });
});
