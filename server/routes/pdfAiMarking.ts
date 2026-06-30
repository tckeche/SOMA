import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireSupabaseAuth, requireTutor } from "../middleware/roles";
import { getPdfMarkingConfig } from "../services/pdfMarkingConfig";
import { pdfRubricSchema, tutorReviewUpdateSchema } from "@shared/pdfMarking";
import { buildPdfMarkingIdempotencyKey } from "../services/pdfReconciliation";
import { createSignedDownloadUrl } from "../services/fileStorage";

function stripStorage<T extends { storagePath?: string | null; annotatedStoragePath?: string | null }>(row: T) { const { storagePath, annotatedStoragePath, ...safe } = row; return safe; }
async function requireOwnedQuiz(quizId: number, tutorId: string) { const quiz = await storage.getSomaQuiz(quizId); return quiz && quiz.authorId === tutorId ? quiz : undefined; }

export function registerPdfAiMarkingRoutes(app: Express): void {
  app.get("/api/tutor/quizzes/:quizId/pdf-marking", requireTutor, async (req, res) => {
    const tutorId = (req as any).tutorId as string; const quizId = Number(req.params.quizId); if (!Number.isInteger(quizId)) return res.status(400).json({ message: "Invalid quiz ID" });
    const quiz = await requireOwnedQuiz(quizId, tutorId); if (!quiz) return res.status(403).json({ message: "Access denied" });
    const [config, documents, rubrics, attachments] = await Promise.all([storage.getPdfAssessmentConfig(quizId), storage.getPdfMarkingDocumentsByQuiz(quizId), storage.getPdfRubricVersionsByQuiz(quizId), storage.getAssessmentAttachmentsByQuiz(quizId)]);
    res.json({ quizId, pdfMarkingMode: quiz.format === "pdf" ? quiz.pdfMarkingMode ?? "manual" : "manual", provider: getPdfMarkingConfig(), config, documents: documents.map(stripStorage), rubrics, attachments: attachments.map(stripStorage) });
  });

  app.patch("/api/tutor/quizzes/:quizId/pdf-marking", requireTutor, async (req, res) => {
    const tutorId = (req as any).tutorId as string; const quizId = Number(req.params.quizId); const body = z.object({ pdfMarkingMode: z.enum(["manual", "dual_ai"]), primaryExamAttachmentId: z.number().int().positive().nullable().optional() }).safeParse(req.body);
    if (!Number.isInteger(quizId) || !body.success) return res.status(400).json({ message: "Invalid request" }); const quiz = await requireOwnedQuiz(quizId, tutorId); if (!quiz) return res.status(403).json({ message: "Access denied" });
    if (quiz.format !== "pdf" && body.data.pdfMarkingMode === "dual_ai") return res.status(400).json({ message: "AI-assisted marking is only available for PDF assessments" });
    const submissions = await storage.getSubmissionUploadsByQuiz(quizId); if (submissions.length && body.data.pdfMarkingMode !== (quiz.pdfMarkingMode ?? "manual")) return res.status(409).json({ message: "Marking mode cannot be changed after submissions exist" });
    const updated = await storage.updateSomaQuiz(quizId, { pdfMarkingMode: quiz.format === "pdf" ? body.data.pdfMarkingMode : "manual" } as any);
    const config = await storage.upsertPdfAssessmentConfig({ quizId, primaryExamAttachmentId: body.data.primaryExamAttachmentId ?? null, preparationStatus: "not_started" });
    res.json({ quiz: updated, config });
  });

  app.post("/api/tutor/quizzes/:quizId/pdf-marking/prepare", requireTutor, async (req, res) => {
    const tutorId = (req as any).tutorId as string; const quizId = Number(req.params.quizId); const quiz = await requireOwnedQuiz(quizId, tutorId); if (!quiz) return res.status(403).json({ message: "Access denied" });
    const attachments = await storage.getAssessmentAttachmentsByQuiz(quizId); const exam = attachments.find((a) => a.documentRole === "exam_paper") ?? attachments[0]; if (!exam) return res.status(400).json({ message: "An exam paper PDF is required" });
    const cfg = getPdfMarkingConfig(); if (!cfg.configured) return res.status(409).json({ message: cfg.configurationError ?? "AI marking is not configured" });
    await storage.upsertPdfAssessmentConfig({ quizId, primaryExamAttachmentId: exam.id, preparationStatus: "queued" });
    const job = await storage.upsertPdfMarkingJob({ jobType: "prepare_assessment", idempotencyKey: `prepare_assessment:${quizId}:${exam.id}`, quizId, payload: { examAttachmentId: exam.id }, maxAttempts: cfg.maxAttempts });
    res.status(202).json({ status: "queued", jobId: job.id });
  });

  app.get("/api/tutor/quizzes/:quizId/pdf-marking/preparation-status", requireTutor, async (req, res) => { const tutorId=(req as any).tutorId as string; const quizId=Number(req.params.quizId); const quiz=await requireOwnedQuiz(quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); res.json(await storage.getPdfAssessmentConfig(quizId) ?? { quizId, preparationStatus: "not_started" }); });

  app.put("/api/tutor/quizzes/:quizId/pdf-marking/rubrics/:rubricVersionId", requireTutor, async (req, res) => { const tutorId=(req as any).tutorId as string; const quizId=Number(req.params.quizId); const id=Number(req.params.rubricVersionId); const quiz=await requireOwnedQuiz(quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const parsed=pdfRubricSchema.safeParse(req.body.rubricJson); if(!parsed.success) return res.status(400).json({message:"Invalid rubric", errors:parsed.error.flatten()}); const current=await storage.getPdfRubricVersion(id); if(!current || current.quizId!==quizId) return res.status(404).json({message:"Rubric not found"}); if(current.status==="approved") return res.status(409).json({message:"Approved rubrics are immutable"}); res.json(await storage.updatePdfRubricVersion(id,{rubricJson:parsed.data,totalMarks:parsed.data.totalMarks,source:"tutor_edited"} as any)); });

  app.post("/api/tutor/quizzes/:quizId/pdf-marking/rubrics/:rubricVersionId/approve", requireTutor, async (req, res) => { const tutorId=(req as any).tutorId as string; const quizId=Number(req.params.quizId); const id=Number(req.params.rubricVersionId); const quiz=await requireOwnedQuiz(quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const rubric=await storage.getPdfRubricVersion(id); if(!rubric || rubric.quizId!==quizId) return res.status(404).json({message:"Rubric not found"}); await storage.updatePdfRubricVersion(id,{status:"approved",approvedBy:tutorId,approvedAt:new Date()} as any); const config=await storage.upsertPdfAssessmentConfig({quizId,activeRubricVersionId:id,preparationStatus:"ready",approvedBy:tutorId,approvedAt:new Date()}); res.json(config); });

  app.get("/api/tutor/submission-uploads/:submissionId/ai-review", requireTutor, async (req,res)=>{ const tutorId=(req as any).tutorId as string; const id=Number(req.params.submissionId); const upload=await storage.getSubmissionUpload(id); if(!upload) return res.status(404).json({message:"Submission not found"}); const quiz=await requireOwnedQuiz(upload.quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const runs=await storage.getPdfMarkingRunsBySubmission(id); const run=runs[0]; res.json({ submission: stripStorage(upload), run: run ? stripStorage(run) : null, reviewItems: run ? await storage.getPdfMarkingReviewItems(run.id) : [], annotations: run ? await storage.getPdfMarkingAnnotations(run.id) : [] }); });

  app.patch("/api/tutor/submission-uploads/:submissionId/ai-review/items/:itemId", requireTutor, async (req,res)=>{ const tutorId=(req as any).tutorId as string; const submissionId=Number(req.params.submissionId); const itemId=Number(req.params.itemId); if(!Number.isInteger(submissionId)||!Number.isInteger(itemId)) return res.status(400).json({message:"Invalid id"}); const upload=await storage.getSubmissionUpload(submissionId); if(!upload) return res.status(404).json({message:"Submission not found"}); const quiz=await requireOwnedQuiz(upload.quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const parsed=tutorReviewUpdateSchema.safeParse(req.body); if(!parsed.success) return res.status(400).json({message:"Invalid request"});
    // IDOR guard: :itemId must belong to one of THIS submission's runs. Without
    // it a tutor could pass one of their own owned submissions (passing the
    // ownership gate above) plus an arbitrary itemId from another tutor's quiz
    // and overwrite that item's resolution fields. updatePdfMarkingReviewItem
    // updates purely by id with no run/submission scoping.
    const runs=await storage.getPdfMarkingRunsBySubmission(upload.id); const itemLists=await Promise.all(runs.map((r)=>storage.getPdfMarkingReviewItems(r.id))); if(!itemLists.flat().some((i)=>i.id===itemId)) return res.status(404).json({message:"Review item not found"});
    res.json(await storage.updatePdfMarkingReviewItem(itemId,{...parsed.data,resolvedBy:tutorId,resolvedAt:new Date()} as any)); });

  app.post("/api/tutor/submission-uploads/:submissionId/ai-retry", requireTutor, async (req,res)=>{ const tutorId=(req as any).tutorId as string; const upload=await storage.getSubmissionUpload(Number(req.params.submissionId)); if(!upload) return res.status(404).json({message:"Submission not found"}); const quiz=await requireOwnedQuiz(upload.quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const config=await storage.getPdfAssessmentConfig(upload.quizId); if(!config?.activeRubricVersionId || !upload.contentHash) return res.status(409).json({message:"Rubric is not ready"}); const key=buildPdfMarkingIdempotencyKey({submissionUploadId:upload.id,submissionVersion:upload.submissionVersion,contentHash:upload.contentHash,rubricVersionId:config.activeRubricVersionId}); const job=await storage.upsertPdfMarkingJob({jobType:"mark_submission",idempotencyKey:key,quizId:upload.quizId,submissionUploadId:upload.id,rubricVersionId:config.activeRubricVersionId,payload:{},maxAttempts:getPdfMarkingConfig().maxAttempts}); res.status(202).json({jobId:job.id}); });

  app.post("/api/tutor/submission-uploads/:submissionId/ai-approve", requireTutor, async (req,res)=>{ const tutorId=(req as any).tutorId as string; const submissionId=Number(req.params.submissionId); if(!Number.isInteger(submissionId)) return res.status(400).json({message:"Invalid id"}); const fb=z.object({feedback:z.string().max(5000).optional()}).safeParse(req.body ?? {}); if(!fb.success) return res.status(400).json({message:"Invalid feedback"}); const upload=await storage.getSubmissionUpload(submissionId); if(!upload) return res.status(404).json({message:"Submission not found"}); const quiz=await requireOwnedQuiz(upload.quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const runs=await storage.getPdfMarkingRunsBySubmission(upload.id); const run=runs[0]; if(!run) return res.status(409).json({message:"No AI run to approve"}); const items=await storage.getPdfMarkingReviewItems(run.id); if(items.some((i)=>i.resolutionStatus==="pending")) return res.status(409).json({message:"Resolve all review items before approval"});
    // proposedScore only sums the rubric items the two AI markers AGREED on;
    // every disputed item was withheld to reviewItems and resolved by the tutor.
    // Fold those tutor-resolved marks back in, else an approved submission
    // silently under-scores the student by the full value of every disputed mark.
    const maxScore=run.maxScore ?? null;
    const resolvedTotal=items.filter((i)=>i.resolutionStatus==="accepted"||i.resolutionStatus==="overridden").reduce((s,i)=>s+(i.resolvedMarks ?? 0),0);
    const rawScore=(run.proposedScore ?? 0)+resolvedTotal;
    const score=maxScore!=null ? Math.min(rawScore,maxScore) : rawScore;
    const updated=await storage.markSubmissionUpload(upload.id,{score,maxScore,feedback:fb.data.feedback ?? "Approved AI-assisted PDF marking result.",status:"marked",markedAt:new Date(),aiMarkingStatus:"approved"}); res.json(stripStorage(updated!)); });

  app.post("/api/tutor/submission-uploads/:submissionId/ai-manual-override", requireTutor, async (req,res)=>{ const tutorId=(req as any).tutorId as string; const upload=await storage.getSubmissionUpload(Number(req.params.submissionId)); if(!upload) return res.status(404).json({message:"Submission not found"}); const quiz=await requireOwnedQuiz(upload.quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const parsed=z.object({score:z.number().int().min(0),maxScore:z.number().int().positive().nullable().optional(),feedback:z.string().max(5000).optional()}).safeParse(req.body); if(!parsed.success) return res.status(400).json({message:"Invalid request"}); const updated=await storage.markSubmissionUpload(upload.id,{score:parsed.data.score,maxScore:parsed.data.maxScore ?? null,feedback:parsed.data.feedback ?? null,status:"marked",markedAt:new Date(),aiMarkingStatus:"manual_override"}); res.json(stripStorage(updated!)); });

  app.get("/api/tutor/submission-uploads/:submissionId/annotated-download", requireTutor, async (req,res)=>{ const tutorId=(req as any).tutorId as string; const upload=await storage.getSubmissionUpload(Number(req.params.submissionId)); if(!upload) return res.status(404).json({message:"Submission not found"}); const quiz=await requireOwnedQuiz(upload.quizId,tutorId); if(!quiz) return res.status(403).json({message:"Access denied"}); const run=(await storage.getPdfMarkingRunsBySubmission(upload.id))[0]; if(!run?.annotatedStoragePath) return res.status(404).json({message:"Annotated PDF not available"}); res.json({url: await createSignedDownloadUrl(run.annotatedStoragePath,300,`annotated-${upload.filename}`)}); });

  app.get("/api/quizzes/:quizId/submission-upload/annotated-download", requireSupabaseAuth, async (req,res)=>{ const studentId=(req as any).authUser.id as string; const upload=await storage.getSubmissionUploadByStudent(Number(req.params.quizId),studentId); if(!upload || upload.status!=="marked") return res.status(404).json({message:"Annotated PDF not available"}); const run=(await storage.getPdfMarkingRunsBySubmission(upload.id))[0]; if(!run?.annotatedStoragePath) return res.status(404).json({message:"Annotated PDF not available"}); res.json({url: await createSignedDownloadUrl(run.annotatedStoragePath,300,`annotated-${upload.filename}`)}); });
}
