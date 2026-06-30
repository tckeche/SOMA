import crypto from "crypto";
import { storage } from "../../storage";
import { createSignedDownloadUrl, FileStorageError, PDF_MIME, uploadPdf } from "../../services/fileStorage";
import { buildPdfMarkingIdempotencyKey } from "../../services/pdfReconciliation";
import { looksLikePdf, publicSubmission } from "../fileStorageAccess/service";
import { requireTutorOwnsQuiz } from "./policies";

export class PdfSubmissionError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function upload(quizId: number, studentId: string, file: Express.Multer.File | undefined) {
  if (!file) throw new PdfSubmissionError(400, "PDF required");
  if (!looksLikePdf(file.buffer)) throw new PdfSubmissionError(400, "File is not a valid PDF");
  const [assignment, quiz] = await Promise.all([storage.getQuizAssignment(quizId, studentId), storage.getSomaQuiz(quizId)]);
  if (!assignment) throw new PdfSubmissionError(403, "Access denied");
  if (!quiz || quiz.format !== "pdf") throw new PdfSubmissionError(400, "This assessment does not accept PDF responses");
  const contentHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const config = quiz.pdfMarkingMode === "dual_ai" ? await storage.getPdfAssessmentConfig(quizId) : undefined;
  const aiReady = quiz.pdfMarkingMode === "dual_ai" && config?.preparationStatus === "ready" && config.activeRubricVersionId;
  const storagePath = quiz.pdfMarkingMode === "dual_ai" ? `submissions/${quizId}/${studentId}/versions/${Date.now()}-${crypto.randomUUID()}.pdf` : `submissions/${quizId}/${studentId}.pdf`;
  await uploadPdf(storagePath, file.buffer);
  const row = await storage.upsertSubmissionUpload({ quizId, studentId, filename: file.originalname, storagePath, mimeType: PDF_MIME, sizeBytes: file.size, contentHash, aiMarkingStatus: quiz.pdfMarkingMode === "dual_ai" ? (aiReady ? "queued" : "blocked_setup") : null });
  if (quiz.pdfMarkingMode === "dual_ai" && aiReady && config?.activeRubricVersionId) {
    await storage.upsertPdfMarkingJob({ jobType: "mark_submission", idempotencyKey: buildPdfMarkingIdempotencyKey({ submissionUploadId: row.id, submissionVersion: row.submissionVersion, contentHash, rubricVersionId: config.activeRubricVersionId }), quizId, submissionUploadId: row.id, rubricVersionId: config.activeRubricVersionId, payload: { submissionVersion: row.submissionVersion }, maxAttempts: Number(process.env.PDF_MARKING_MAX_ATTEMPTS || 3) });
  }
  return publicSubmission(row);
}

export async function getOwn(quizId: number, studentId: string) {
  const row = await storage.getSubmissionUploadByStudent(quizId, studentId);
  if (!row) throw new PdfSubmissionError(404, "No submission found");
  return publicSubmission(row);
}

export async function listForTutor(quizId: number, tutorId: string) {
  const quiz = await requireTutorOwnsQuiz(quizId, tutorId);
  if (!quiz) throw new PdfSubmissionError(403, "Access denied");
  const rows = await storage.getSubmissionUploadsByQuiz(quizId);
  return Promise.all(rows.map(async (row) => {
    const student = await storage.getSomaUserById(row.studentId);
    return { ...publicSubmission(row), studentName: student?.displayName || student?.email || row.studentId };
  }));
}

export async function downloadForTutor(id: number, tutorId: string) {
  const upload = await storage.getSubmissionUpload(id);
  if (!upload) throw new PdfSubmissionError(404, "Submission not found");
  const quiz = await storage.getSomaQuiz(upload.quizId);
  if (!quiz || quiz.authorId !== tutorId) throw new PdfSubmissionError(403, "Access denied");
  return { url: await createSignedDownloadUrl(upload.storagePath, 300, upload.filename) };
}

export { FileStorageError };
