import crypto from "crypto";
import { storage } from "../../storage";
import { createSignedDownloadUrl, deleteObject, FileStorageError, PDF_MIME, uploadPdf, isStorageConfigured } from "../../services/fileStorage";
import { looksLikePdf, publicAttachment } from "../fileStorageAccess/service";
import { canAccessQuizAttachments, requireTutorOwnsQuiz } from "./policies";
import { documentRole } from "./validators";

export class PdfAttachmentError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function upload(quizId: number, tutorId: string, file: Express.Multer.File | undefined, body: any) {
  if (!file) throw new PdfAttachmentError(400, "PDF required");
  if (!looksLikePdf(file.buffer)) throw new PdfAttachmentError(400, "File is not a valid PDF");
  const quiz = await requireTutorOwnsQuiz(quizId, tutorId);
  if (!quiz) throw new PdfAttachmentError(403, "Access denied");
  if (quiz.format !== "pdf") throw new PdfAttachmentError(400, "Worksheets can only be added to PDF-format assessments");
  const storagePath = `assessments/${quizId}/${crypto.randomUUID()}.pdf`;
  await uploadPdf(storagePath, file.buffer);
  const row = await storage.createAssessmentAttachment({ quizId, filename: file.originalname, storagePath, mimeType: PDF_MIME, sizeBytes: file.size, uploadedBy: tutorId, documentRole: documentRole(body?.documentRole) });
  return publicAttachment(row);
}

export async function listForTutor(quizId: number, tutorId: string) {
  const quiz = await requireTutorOwnsQuiz(quizId, tutorId);
  if (!quiz) throw new PdfAttachmentError(403, "Access denied");
  return (await storage.getAssessmentAttachmentsByQuiz(quizId)).map(publicAttachment);
}

export async function remove(quizId: number, attachmentId: number, tutorId: string) {
  const quiz = await requireTutorOwnsQuiz(quizId, tutorId);
  if (!quiz) throw new PdfAttachmentError(403, "Access denied");
  const attachment = await storage.getAssessmentAttachment(attachmentId);
  if (!attachment || attachment.quizId !== quizId) throw new PdfAttachmentError(404, "Attachment not found");
  if (isStorageConfigured()) await deleteObject(attachment.storagePath);
  await storage.deleteAssessmentAttachment(attachmentId);
  return { success: true };
}

export async function listForUser(quizId: number, userId: string) {
  if (!(await canAccessQuizAttachments(quizId, userId))) throw new PdfAttachmentError(403, "Access denied");
  return (await storage.getAssessmentAttachmentsByQuiz(quizId)).map(publicAttachment);
}

export async function download(quizId: number, attachmentId: number, userId: string) {
  if (!(await canAccessQuizAttachments(quizId, userId))) throw new PdfAttachmentError(403, "Access denied");
  const attachment = await storage.getAssessmentAttachment(attachmentId);
  if (!attachment || attachment.quizId !== quizId) throw new PdfAttachmentError(404, "Attachment not found");
  return { url: await createSignedDownloadUrl(attachment.storagePath, 300, attachment.filename) };
}

export { FileStorageError };
