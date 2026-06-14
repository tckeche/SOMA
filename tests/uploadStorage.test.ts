/**
 * UPLOAD STORAGE LAYER TESTS (MemoryStorage)
 *
 * Covers the PDF-uploads foundation methods on the real `MemoryStorage`:
 *   - assessment attachment create / list / get / delete
 *   - submission upsert inserts then replaces & resets the mark fields
 *   - markSubmissionUpload sets score/feedback/status/marked_at
 *   - getSubmissionUploadByStudent returns the right row
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStorage } from "../server/storage";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe("assessment attachments", () => {
  it("creates, lists, gets and deletes", async () => {
    const a = await storage.createAssessmentAttachment({
      quizId: 1,
      filename: "worksheet.pdf",
      storagePath: "quiz/1/worksheet.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      uploadedBy: null,
    });
    expect(a.id).toBeGreaterThan(0);
    expect(a.createdAt).toBeInstanceOf(Date);

    await storage.createAssessmentAttachment({
      quizId: 1,
      filename: "second.pdf",
      storagePath: "quiz/1/second.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedBy: null,
    });
    // Different quiz — must not show up in quiz 1's list.
    await storage.createAssessmentAttachment({
      quizId: 2,
      filename: "other.pdf",
      storagePath: "quiz/2/other.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      uploadedBy: null,
    });

    const list = await storage.getAssessmentAttachmentsByQuiz(1);
    expect(list).toHaveLength(2);

    const got = await storage.getAssessmentAttachment(a.id);
    expect(got?.filename).toBe("worksheet.pdf");

    await storage.deleteAssessmentAttachment(a.id);
    expect(await storage.getAssessmentAttachment(a.id)).toBeUndefined();
    expect(await storage.getAssessmentAttachmentsByQuiz(1)).toHaveLength(1);
  });
});

describe("submission uploads", () => {
  const base = {
    quizId: 7,
    studentId: "student-1",
    filename: "answers.pdf",
    storagePath: "quiz/7/student-1.pdf",
    mimeType: "application/pdf",
    sizeBytes: 500,
  };

  it("upsert inserts once then replaces & resets mark fields", async () => {
    const first = await storage.upsertSubmissionUpload({ ...base });
    expect(first.status).toBe("submitted");

    // Mark it.
    const marked = await storage.markSubmissionUpload(first.id, {
      score: 8,
      feedback: "good",
      status: "marked",
      markedAt: new Date(),
    });
    expect(marked?.score).toBe(8);
    expect(marked?.status).toBe("marked");

    // Re-upload for the same (quiz, student) replaces the file and resets marks.
    const second = await storage.upsertSubmissionUpload({
      ...base,
      filename: "answers-v2.pdf",
      storagePath: "quiz/7/student-1-v2.pdf",
      sizeBytes: 999,
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.filename).toBe("answers-v2.pdf");
    expect(second.sizeBytes).toBe(999);
    expect(second.score).toBeNull();
    expect(second.feedback).toBeNull();
    expect(second.status).toBe("submitted");
    expect(second.markedAt).toBeNull();

    // Only one row exists for the pair.
    expect(await storage.getSubmissionUploadsByQuiz(7)).toHaveLength(1);
  });

  it("markSubmissionUpload sets score/feedback/status/marked_at", async () => {
    const row = await storage.upsertSubmissionUpload({ ...base });
    const at = new Date();
    const marked = await storage.markSubmissionUpload(row.id, {
      score: 5,
      feedback: "needs work",
      status: "marked",
      markedAt: at,
    });
    expect(marked?.score).toBe(5);
    expect(marked?.feedback).toBe("needs work");
    expect(marked?.status).toBe("marked");
    expect(marked?.markedAt).toBe(at);
  });

  it("getSubmissionUploadByStudent returns the right row", async () => {
    await storage.upsertSubmissionUpload({ ...base });
    await storage.upsertSubmissionUpload({ ...base, studentId: "student-2", storagePath: "quiz/7/student-2.pdf" });

    const s1 = await storage.getSubmissionUploadByStudent(7, "student-1");
    const s2 = await storage.getSubmissionUploadByStudent(7, "student-2");
    expect(s1?.studentId).toBe("student-1");
    expect(s2?.studentId).toBe("student-2");
    expect(await storage.getSubmissionUploadByStudent(7, "nobody")).toBeUndefined();

    const byId = await storage.getSubmissionUpload(s1!.id);
    expect(byId?.studentId).toBe("student-1");
  });
});
