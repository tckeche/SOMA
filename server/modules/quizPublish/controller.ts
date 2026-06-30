import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import { newTraceId } from "../../services/quizTraceLog";
import * as service from "./service";
import { parseQuizId, publishBodySchema } from "./validators";
function tutorId(req: Request) { return (req as any).tutorId as string; }
function sendDomain(res: Response, err: service.QuizPublishError) { return res.status(err.status).json({ message: err.message, ...(err.details ?? {}) }); }
export async function publish(req: Request, res: Response) { const traceId = newTraceId(); try { const quizId = parseQuizId(req.params.quizId); const parsed = publishBodySchema.safeParse(req.body ?? {}); const body = parsed.success ? parsed.data : {}; return res.json(await service.publish(quizId, tutorId(req), body, traceId)); } catch (err: any) { if (err instanceof service.QuizPublishError) return sendDomain(res, err); return sendInternalError(req, res, err, "routes.failed_to_publish", "Failed to publish"); } }
