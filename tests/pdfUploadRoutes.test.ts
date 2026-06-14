/**
 * PDF UPLOAD ROUTE INTEGRATION TESTS
 *
 * Covers the tutor worksheet-attachment and student PDF-response endpoints
 * registered in server/routes.ts, using supertest + MemoryStorage.
 *
 * Network side of fileStorage (Supabase REST) is mocked at the module level so
 * uploadPdf/createSignedDownloadUrl/deleteObject never touch the network, and
 * isStorageConfigured() reports true so the 503 guard is satisfied.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import supertest from "supertest";
import jwt from "jsonwebtoken";

// ─── MemoryStorage ────────────────────────────────────────────────────────────
vi.mock("../server/db", () => ({ db: null }));

// ─── Rate limiter passthrough ─────────────────────────────────────────────────
vi.mock("express-rate-limit", () => ({
  default: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  rateLimit: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  ipKeyGenerator: vi.fn().mockReturnValue("test-ip"),
}));

// ─── Mock fileStorage network functions; keep constants/types/error ───────────
vi.mock("../server/services/fileStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/fileStorage")>();
  return {
    ...actual,
    isStorageConfigured: vi.fn(() => true),
    ensureUploadBucket: vi.fn(async () => {}),
    uploadPdf: vi.fn(async () => {}),
    createSignedDownloadUrl: vi.fn(async (path: string) => `https://signed.example/${path}`),
    deleteObject: vi.fn(async () => {}),
  };
});

import { registerRoutes } from "../server/routes";
import { deleteObject } from "../server/services/fileStorage";

let app: express.Express;
let httpServer: any;
let request: supertest.SuperTest<supertest.Test>;

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing-only-32chars";

const TUTOR_A = "aaaaaaaa-1111-1111-1111-111111111111";
const TUTOR_B = "bbbbbbbb-2222-2222-2222-222222222222";
const STUDENT_ASSIGNED = "cccccccc-3333-3333-3333-333333333333";
const STUDENT_UNASSIGNED = "dddddddd-4444-4444-4444-444444444444";

async function sync(id: string, email: string) {
  await request.post("/api/auth/sync").send({ id, email, user_metadata: {} });
}
function tokenFor(id: string, email: string) {
  return jwt.sign({ sub: id, email, role: "authenticated" }, SECRET, { expiresIn: "1h" });
}

let tutorAToken: string;
let tutorBToken: string;
let studentAssignedToken: string;
let studentUnassignedToken: string;

const PDF = Buffer.from("%PDF-1.4 test pdf body");

beforeAll(async () => {
  app = express();
  app.use(express.json());
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  request = supertest(app);

  await sync(TUTOR_A, "tutora@melaniacalvin.com");
  await sync(TUTOR_B, "tutorb@melaniacalvin.com");
  await sync(STUDENT_ASSIGNED, "studassigned@example.com");
  await sync(STUDENT_UNASSIGNED, "studunassigned@example.com");

  tutorAToken = tokenFor(TUTOR_A, "tutora@melaniacalvin.com");
  tutorBToken = tokenFor(TUTOR_B, "tutorb@melaniacalvin.com");
  studentAssignedToken = tokenFor(STUDENT_ASSIGNED, "studassigned@example.com");
  studentUnassignedToken = tokenFor(STUDENT_UNASSIGNED, "studunassigned@example.com");
});

afterAll(() => httpServer.close());

// Create a quiz owned by TUTOR_A and assign STUDENT_ASSIGNED to it.
async function createQuizWithAssignedStudent(format: "mcq" | "pdf" = "pdf"): Promise<number> {
  const quizRes = await request
    .post("/api/tutor/quizzes")
    .set("Authorization", `Bearer ${tutorAToken}`)
    .send({ title: "Worksheet Quiz", timeLimitMinutes: 30, format });
  const quizId = quizRes.body.id;

  await request
    .post("/api/tutor/students/adopt")
    .set("Authorization", `Bearer ${tutorAToken}`)
    .send({ studentIds: [STUDENT_ASSIGNED] });
  const assignRes = await request
    .post(`/api/tutor/quizzes/${quizId}/assign`)
    .set("Authorization", `Bearer ${tutorAToken}`)
    .send({ studentIds: [STUDENT_ASSIGNED] });
  expect([200, 201]).toContain(assignRes.status);
  return quizId;
}

describe("tutor worksheet attachments", () => {
  it("uploads, lists, downloads and deletes; rejects non-owner and unassigned", async () => {
    const quizId = await createQuizWithAssignedStudent();

    // (1) Upload creates a row.
    const up = await request
      .post(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .attach("file", PDF, { filename: "worksheet.pdf", contentType: "application/pdf" });
    expect(up.status).toBe(201);
    expect(up.body.filename).toBe("worksheet.pdf");
    // storagePath is an internal key and must not be exposed in responses.
    expect(up.body.storagePath).toBeUndefined();
    const attachmentId = up.body.id;

    // (2) List (owner).
    const list = await request
      .get(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    // Ownership: a different tutor cannot list/upload/delete.
    const otherList = await request
      .get(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorBToken}`);
    expect(otherList.status).toBe(403);
    const otherDel = await request
      .delete(`/api/tutor/quizzes/${quizId}/attachments/${attachmentId}`)
      .set("Authorization", `Bearer ${tutorBToken}`);
    expect(otherDel.status).toBe(403);

    // (4) Student access: assigned student can list.
    const studList = await request
      .get(`/api/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${studentAssignedToken}`);
    expect(studList.status).toBe(200);
    expect(studList.body).toHaveLength(1);

    // Unassigned student is rejected.
    const unassignedList = await request
      .get(`/api/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${studentUnassignedToken}`);
    expect(unassignedList.status).toBe(403);

    // (5) Download: assigned student allowed, unassigned rejected.
    const dl = await request
      .get(`/api/quizzes/${quizId}/attachments/${attachmentId}/download`)
      .set("Authorization", `Bearer ${studentAssignedToken}`);
    expect(dl.status).toBe(200);
    expect(dl.body.url).toContain("https://signed.example/");

    const unassignedDl = await request
      .get(`/api/quizzes/${quizId}/attachments/${attachmentId}/download`)
      .set("Authorization", `Bearer ${studentUnassignedToken}`);
    expect(unassignedDl.status).toBe(403);

    // (3) Delete (owner).
    const del = await request
      .delete(`/api/tutor/quizzes/${quizId}/attachments/${attachmentId}`)
      .set("Authorization", `Bearer ${tutorAToken}`);
    expect(del.status).toBe(200);
    const after = await request
      .get(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`);
    expect(after.body).toHaveLength(0);
  });

  it("rejects a non-PDF upload with 400", async () => {
    const quizId = await createQuizWithAssignedStudent();
    const bad = await request
      .post(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/PDF required/i);
  });

  it("rejects a spoofed Content-Type that is not a real PDF (magic bytes)", async () => {
    const quizId = await createQuizWithAssignedStudent();
    const res = await request
      .post(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .attach("file", Buffer.from("<html>not a pdf</html>"), {
        filename: "fake.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not a valid PDF/i);
  });
});

describe("format enforcement (mcq assessments reject PDF flows)", () => {
  it("rejects a student PDF response on an mcq-format assessment", async () => {
    const quizId = await createQuizWithAssignedStudent("mcq");
    const res = await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`)
      .attach("file", PDF, { filename: "answers.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/does not accept PDF responses/i);
  });

  it("rejects a tutor worksheet upload on an mcq-format assessment", async () => {
    const quizId = await createQuizWithAssignedStudent("mcq");
    const res = await request
      .post(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .attach("file", PDF, { filename: "worksheet.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/PDF-format/i);
  });
});

describe("student submission uploads", () => {
  it("assigned student upsert creates then replaces & resets the mark", async () => {
    const quizId = await createQuizWithAssignedStudent();

    const first = await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`)
      .attach("file", PDF, { filename: "answers.pdf", contentType: "application/pdf" });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("submitted");
    // storagePath is an internal key and must not be exposed in responses.
    expect(first.body.storagePath).toBeUndefined();
    const submissionId = first.body.id;

    // Tutor marks it.
    const mark = await request
      .post(`/api/tutor/submission-uploads/${submissionId}/mark`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .send({ score: 7, maxScore: 10, feedback: "nice" });
    expect(mark.status).toBe(200);
    expect(mark.body.status).toBe("marked");

    // Re-upload resets the mark.
    const second = await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`)
      .attach("file", PDF, { filename: "answers-v2.pdf", contentType: "application/pdf" });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(submissionId);
    expect(second.body.filename).toBe("answers-v2.pdf");
    expect(second.body.status).toBe("submitted");
    expect(second.body.score).toBeNull();
    expect(second.body.feedback).toBeNull();
  });

  it("rejects an unassigned student", async () => {
    const quizId = await createQuizWithAssignedStudent();
    const res = await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentUnassignedToken}`)
      .attach("file", PDF, { filename: "answers.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(403);
  });

  it("student GET returns own row with score/feedback after marking", async () => {
    const quizId = await createQuizWithAssignedStudent();

    // 404 before any upload.
    const empty = await request
      .get(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`);
    expect(empty.status).toBe(404);

    const up = await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`)
      .attach("file", PDF, { filename: "answers.pdf", contentType: "application/pdf" });
    const submissionId = up.body.id;

    await request
      .post(`/api/tutor/submission-uploads/${submissionId}/mark`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .send({ score: 9, maxScore: 10, feedback: "well done" });

    const own = await request
      .get(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`);
    expect(own.status).toBe(200);
    expect(own.body.score).toBe(9);
    expect(own.body.maxScore).toBe(10);
    expect(own.body.feedback).toBe("well done");
    expect(own.body.status).toBe("marked");
  });
});

describe("tutor view + mark submission uploads", () => {
  it("lists uploads with student name, downloads, marks; rejects score>maxScore and non-owner", async () => {
    const quizId = await createQuizWithAssignedStudent();
    const up = await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`)
      .attach("file", PDF, { filename: "answers.pdf", contentType: "application/pdf" });
    const submissionId = up.body.id;

    // (8) List with student name.
    const list = await request
      .get(`/api/tutor/quizzes/${quizId}/submission-uploads`)
      .set("Authorization", `Bearer ${tutorAToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].studentName).toBeTruthy();

    // Non-owner tutor rejected.
    const otherList = await request
      .get(`/api/tutor/quizzes/${quizId}/submission-uploads`)
      .set("Authorization", `Bearer ${tutorBToken}`);
    expect(otherList.status).toBe(403);

    // (9) Download signed url.
    const dl = await request
      .get(`/api/tutor/submission-uploads/${submissionId}/download`)
      .set("Authorization", `Bearer ${tutorAToken}`);
    expect(dl.status).toBe(200);
    expect(dl.body.url).toContain("https://signed.example/");

    const otherDl = await request
      .get(`/api/tutor/submission-uploads/${submissionId}/download`)
      .set("Authorization", `Bearer ${tutorBToken}`);
    expect(otherDl.status).toBe(403);

    // (10) score > maxScore rejected.
    const bad = await request
      .post(`/api/tutor/submission-uploads/${submissionId}/mark`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .send({ score: 11, maxScore: 10 });
    expect(bad.status).toBe(400);

    // Non-owner cannot mark.
    const otherMark = await request
      .post(`/api/tutor/submission-uploads/${submissionId}/mark`)
      .set("Authorization", `Bearer ${tutorBToken}`)
      .send({ score: 5 });
    expect(otherMark.status).toBe(403);

    // Valid mark sets score/feedback/status/markedAt.
    const mark = await request
      .post(`/api/tutor/submission-uploads/${submissionId}/mark`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .send({ score: 8, maxScore: 10, feedback: "good" });
    expect(mark.status).toBe(200);
    expect(mark.body.score).toBe(8);
    expect(mark.body.feedback).toBe("good");
    expect(mark.body.status).toBe("marked");
    expect(mark.body.markedAt).toBeTruthy();
  });
});

describe("quiz delete purges storage objects", () => {
  it("calls deleteObject for the quiz's attachment + submission paths", async () => {
    const quizId = await createQuizWithAssignedStudent();
    await request
      .post(`/api/tutor/quizzes/${quizId}/attachments`)
      .set("Authorization", `Bearer ${tutorAToken}`)
      .attach("file", PDF, { filename: "worksheet.pdf", contentType: "application/pdf" });
    await request
      .post(`/api/quizzes/${quizId}/submission-upload`)
      .set("Authorization", `Bearer ${studentAssignedToken}`)
      .attach("file", PDF, { filename: "answers.pdf", contentType: "application/pdf" });

    (deleteObject as unknown as ReturnType<typeof vi.fn>).mockClear();
    const del = await request
      .delete(`/api/tutor/quizzes/${quizId}`)
      .set("Authorization", `Bearer ${tutorAToken}`);
    expect(del.status).toBe(200);

    const calledPaths = (deleteObject as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calledPaths.some((p: string) => p.startsWith(`assessments/${quizId}/`))).toBe(true);
    expect(calledPaths).toContain(`submissions/${quizId}/${STUDENT_ASSIGNED}.pdf`);
  });
});
