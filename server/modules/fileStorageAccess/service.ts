import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { storage } from "../../storage";
import { deleteObject, isStorageConfigured, MAX_PDF_BYTES, PDF_MIME } from "../../services/fileStorage";
import { logWarn } from "../../utils/logging";

const pdfFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== PDF_MIME) {
      cb(new Error("PDF required"));
      return;
    }
    cb(null, true);
  },
});

export function pdfUploadField(field: string) {
  const mw = pdfFileUpload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "File too large (max 20MB)" });
        }
        return res.status(400).json({ error: "Invalid upload" });
      }
      if (err instanceof Error && err.message === "PDF required") {
        return res.status(400).json({ error: "PDF required" });
      }
      return res.status(400).json({ error: "Invalid upload" });
    });
  };
}

export function looksLikePdf(buf: Buffer | undefined): boolean {
  return Boolean(buf && buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-");
}

export function requireStorageConfigured(res: Response): boolean {
  if (!isStorageConfigured()) {
    res.status(503).json({ message: "File storage is not configured" });
    return false;
  }
  return true;
}

export function publicAttachment<T extends { storagePath?: string }>(row: T) {
  const { storagePath, ...rest } = row;
  return rest;
}

export function publicSubmission<T extends { storagePath?: string; annotatedStoragePath?: string | null }>(row: T) {
  const { storagePath, annotatedStoragePath, ...rest } = row;
  return { ...rest, hasAnnotatedPdf: Boolean(annotatedStoragePath) };
}

export async function collectQuizStoragePaths(quizId: number): Promise<string[]> {
  if (!isStorageConfigured()) return [];
  try {
    const [attachments, submissions] = await Promise.all([
      storage.getAssessmentAttachmentsByQuiz(quizId),
      storage.getSubmissionUploadsByQuiz(quizId),
    ]);
    return [...attachments.map((a) => a.storagePath), ...submissions.map((s) => s.storagePath)];
  } catch (err) {
    logWarn("quiz_storage_collect_failed", { quizId, error: (err as Error)?.message });
    return [];
  }
}

export async function purgeStorageObjects(paths: string[]): Promise<void> {
  if (paths.length === 0 || !isStorageConfigured()) return;
  try {
    await Promise.all(paths.map((p) => deleteObject(p).catch(() => {})));
  } catch (err) {
    logWarn("quiz_storage_purge_failed", { error: (err as Error)?.message });
  }
}
