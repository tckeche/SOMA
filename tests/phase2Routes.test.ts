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
vi.mock("../server/services/pythonGraphRenderer", () => ({ renderGraphSvgWithPython: vi.fn().mockResolvedValue("<svg />") }));
vi.mock("../server/services/syllabusCatalogue", () => ({
  listExaminingBodies: vi.fn().mockResolvedValue(["Cambridge"]),
  listLevelsForBody: vi.fn().mockResolvedValue(["A Level"]),
  listAllSubjectNames: vi.fn().mockResolvedValue(["Mathematics"]),
  listSubjectsForBodyLevel: vi.fn().mockResolvedValue(["Mathematics"]),
  resolveSyllabus: vi.fn().mockResolvedValue({ id: 1, code: "9709", title: "Mathematics" }),
  listTopics: vi.fn().mockResolvedValue([{ id: 10, title: "Quadratics", topicNumber: "1" }]),
  getTopicContext: vi.fn().mockResolvedValue([{ id: 10, title: "Quadratics" }]),
}));

import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";
import { discoverDomainModules } from "../server/modules/routerLoader";

let app: express.Express;
let request: supertest.SuperTest<supertest.Test>;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  server = createServer(app);
  await registerRoutes(server, app);
  request = supertest(app);
});

function token(userId: string, email: string) {
  return jwt.sign({ sub: userId, email, role: "authenticated" }, process.env.JWT_SECRET || "test-jwt-secret-for-testing-only-32chars", { expiresIn: "1h" });
}

async function syncUser(userId: string, email: string, requestedRole?: string) {
  const res = await request.post("/api/auth/sync").send({ id: userId, email, user_metadata: { requested_role: requestedRole } });
  expect(res.status).toBe(200);
  return res.body;
}

describe("phase 2 migrated routes", () => {
  it("auth sync preserves existing roles and blocks role escalation", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const first = await syncUser(id, "phase2-student@example.com", "student");
    expect(first.role).toBe("student");
    const second = await syncUser(id, "phase2-student@example.com", "tutor");
    expect(second.role).toBe("student");
  });

  it("auth me safely creates missing users", async () => {
    const res = await request.get("/api/auth/me").query({ userId: "11111111-1111-4111-8111-111111111112", email: "phase2-me@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "11111111-1111-4111-8111-111111111112", email: "phase2-me@example.com", role: "student" });
  });

  it("password reset does not reveal whether an email exists", async () => {
    await syncUser("11111111-1111-4111-8111-111111111113", "known-reset@example.com", "student");
    const known = await request.post("/api/auth/forgot-password").send({ email: "known-reset@example.com" });
    const unknown = await request.post("/api/auth/forgot-password").send({ email: "unknown-reset@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it("graph render rejects invalid graph specs", async () => {
    await syncUser("11111111-1111-4111-8111-111111111114", "phase2-graph@example.com", "student");
    const res = await request.post("/api/graph/render-svg").set("Authorization", `Bearer ${token("11111111-1111-4111-8111-111111111114", "phase2-graph@example.com")}`).send({ spec: { nope: true } });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe("Invalid graph spec");
  });

  it("syllabus catalogue topics return topic titles", async () => {
    const tutor = await syncUser("11111111-1111-4111-8111-111111111115", "phase2-catalogue@melaniacalvin.com", "tutor");
    expect(tutor.role).toBe("tutor");
    const res = await request.get("/api/catalogue/topics").set("Authorization", `Bearer ${token("11111111-1111-4111-8111-111111111115", "phase2-catalogue@melaniacalvin.com")}`).query({ body: "Cambridge", level: "A Level", subject: "Mathematics" });
    expect(res.status).toBe(200);
    expect(res.body.topics[0]).toMatchObject({ title: "Quadratics", topicNumber: "1" });
  });

  it("tutor cannot access another tutor's student subjects", async () => {
    await syncUser("11111111-1111-4111-8111-111111111116", "phase2-a@melaniacalvin.com", "tutor");
    await syncUser("11111111-1111-4111-8111-111111111117", "phase2-b@melaniacalvin.com", "tutor");
    await storage.adoptStudent("11111111-1111-4111-8111-111111111116", "11111111-1111-4111-8111-111111111118");
    await storage.addStudentSubject({ studentId: "11111111-1111-4111-8111-111111111118", subject: "Maths", examBody: "Cambridge", syllabusCode: "9709", level: "A Level" });
    const res = await request.get("/api/tutor/students/11111111-1111-4111-8111-111111111118/subjects").set("Authorization", `Bearer ${token("11111111-1111-4111-8111-111111111117", "phase2-b@melaniacalvin.com")}`);
    expect(res.status).toBe(403);
  });

  it("tutor cannot access another tutor's student comments", async () => {
    await syncUser("11111111-1111-4111-8111-111111111119", "phase2-comment-a@melaniacalvin.com", "tutor");
    await syncUser("11111111-1111-4111-8111-111111111120", "phase2-comment-b@melaniacalvin.com", "tutor");
    await storage.adoptStudent("11111111-1111-4111-8111-111111111119", "11111111-1111-4111-8111-111111111121");
    await storage.addTutorComment({ tutorId: "11111111-1111-4111-8111-111111111119", studentId: "11111111-1111-4111-8111-111111111121", comment: "Private note" });
    const res = await request.get("/api/tutor/students/11111111-1111-4111-8111-111111111121/comments").set("Authorization", `Bearer ${token("11111111-1111-4111-8111-111111111120", "phase2-comment-b@melaniacalvin.com")}`);
    expect(res.status).toBe(403);
  });

  it("tutor notification unread count is correct", async () => {
    await syncUser("11111111-1111-4111-8111-111111111122", "phase2-notify@melaniacalvin.com", "tutor");
    const n1 = await storage.createTutorNotification({ tutorId: "11111111-1111-4111-8111-111111111122", type: "test", title: "One", message: "One" });
    await storage.createTutorNotification({ tutorId: "11111111-1111-4111-8111-111111111122", type: "test", title: "Two", message: "Two" });
    await storage.markTutorNotificationRead(n1.id, "11111111-1111-4111-8111-111111111122");
    const res = await request.get("/api/tutor/notifications").set("Authorization", `Bearer ${token("11111111-1111-4111-8111-111111111122", "phase2-notify@melaniacalvin.com")}`);
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.notifications).toHaveLength(2);
  });

  it("autoloaded phase 2 modules are discovered", async () => {
    const modules = await discoverDomainModules();
    expect(modules.map((m) => m.name)).toEqual(expect.arrayContaining(["authAccount", "authVerification", "clientDiagnostics", "graphRendering", "syllabusCatalogue", "tutorNotifications", "studentSubjects", "tutorStudentComments"]));
  });

  it("does not leave migrated routes registered in the legacy monolith", async () => {
    const legacyRoutes = readFileSync("server/routes.ts", "utf8");
    expect(legacyRoutes).not.toContain('app.post("/api/auth/sync"');
    expect(legacyRoutes).not.toContain('app.post("/api/graph/render-svg"');
    expect(legacyRoutes).not.toContain('app.get("/api/tutor/notifications"');
    expect(legacyRoutes).not.toContain('app.get("/api/tutor/students/:studentId/comments"');
    expect(legacyRoutes).not.toContain('app.get("/api/tutor/students/:studentId/subjects"');
  });
});
