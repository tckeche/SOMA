import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import { newTraceId } from "../../services/quizTraceLog";
import * as service from "./service";
import { parseQuizId, saveDraftSchema } from "./validators";
function tutorId(req: Request) { return (req as any).tutorId as string; }
function sendDomain(res: Response, err: service.QuizDraftError) { return res.status(err.status).json({ message: err.message }); }
export async function getDraft(req: Request, res: Response) { try { const quizId = parseQuizId(req.params.quizId); if (!quizId) return res.status(400).json({ message: "Invalid quizId" }); return res.json(await service.fetchDraft(quizId, tutorId(req))); } catch (err: any) { if (err instanceof service.QuizDraftError) return sendDomain(res, err); return sendInternalError(req, res, err, "routes.failed_to_fetch_draft", "Failed to fetch draft"); } }
export async function putDraft(req: Request, res: Response) { const traceId = newTraceId(); try { const quizId = parseQuizId(req.params.quizId); if (!quizId) return res.status(400).json({ message: "Invalid quizId" }); const parsed = saveDraftSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: "questions array required" }); return res.json(await service.saveDraft(quizId, tutorId(req), parsed.data.questions as any, traceId)); } catch (err: any) { if (err instanceof service.QuizDraftError) return sendDomain(res, err); return sendInternalError(req, res, err, "routes.failed_to_save_draft", "Failed to save draft"); } }
