/**
 * REGRADE ROUTE TEST
 *
 * The tutor "Regrade submissions" button (TutorQuizReview) POSTs to
 * /api/tutor/quizzes/:quizId/regrade. That endpoint previously did not exist,
 * so the action always 404'd. This pins the registered route: it recomputes
 * completed reports against the current question set, reports how many changed,
 * and is gated to the quiz author.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
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
import { storage } from "../server/storage";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing-only-32chars";
const TUTOR_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TUTOR_B = "bbbbbbbb-2222-2222-2222-222222222222";

let request: supertest.SuperTest<supertest.Test>;
let tutorAToken: string;
let tutorBToken: string;

async function sync(id: string, email: string) {
  await request.post("/api/auth/sync").send({ id, email, user_metadata: {} });
}
const tokenFor = (id: string, email: string) =>
  jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  request = supertest(app);
  await sync(TUTOR_A, "tutora@melaniacalvin.com");
  await sync(TUTOR_B, "tutorb@melaniacalvin.com");
  tutorAToken = tokenFor(TUTOR_A, "tutora@melaniacalvin.com");
  tutorBToken = tokenFor(TUTOR_B, "tutorb@melaniacalvin.com");
});

describe("POST /api/tutor/quizzes/:quizId/regrade", () => {
  it("recomputes completed reports and reports the changes", async () => {
    const quiz = await storage.createSomaQuiz({ title: "Regrade me", topic: "x", authorId: TUTOR_A } as any);
    const [q1, q2] = await storage.createSomaQuestions([
      { quizId: quiz.id, stem: "Q1", options: ["A", "B", "C", "D"], correctAnswer: "A", explanation: "", marks: 2 },
      { quizId: quiz.id, stem: "Q2", options: ["A", "B", "C", "D"], correctAnswer: "B", explanation: "", marks: 1 },
    ] as any);
    // A completed report whose stored score (0) understates the real marks: the
    // student actually answered Q1 correctly (2 marks). A pending report must be
    // left untouched.
    await storage.createSomaReport({ quizId: quiz.id, studentName: "Alice", score: 0, status: "completed", answersJson: { [q1.id]: "A", [q2.id]: "C" } } as any);
    await storage.createSomaReport({ quizId: quiz.id, studentName: "Pending Pat", score: 9, status: "pending", answersJson: { [q1.id]: "A" } } as any);

    const res = await request
      .post(`/api/tutor/quizzes/${quiz.id}/regrade`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.regraded).toBe(1); // only the completed report
    expect(res.body.changed).toBe(1);
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0]).toMatchObject({ studentName: "Alice", oldScore: 0, newScore: 2, maxPossibleScore: 3 });
  });

  it("is gated to the quiz author (403 for another tutor)", async () => {
    const quiz = await storage.createSomaQuiz({ title: "Owned by A", topic: "x", authorId: TUTOR_A } as any);
    const res = await request
      .post(`/api/tutor/quizzes/${quiz.id}/regrade`)
      .set("Authorization", `Bearer ${tutorBToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("400s on a non-numeric quiz id", async () => {
    const res = await request
      .post(`/api/tutor/quizzes/not-a-number/regrade`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
