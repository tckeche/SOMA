import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import * as service from "./service";
import { parseComment } from "./validators";
function ids(req: Request) { return { tutorId: (req as any).tutorId as string, studentId: String(req.params.studentId) }; }
export async function list(req: Request, res: Response) { try { const { tutorId, studentId } = ids(req); return res.json(await service.list(tutorId, studentId)); } catch (err: any) { if (err instanceof service.TutorCommentError) return res.status(err.status).json({ message: err.message }); return sendInternalError(req, res, err, "routes.failed_to_fetch_comments", "Failed to fetch comments"); } }
export async function add(req: Request, res: Response) { try { const { tutorId, studentId } = ids(req); const comment = parseComment(req.body); if (!comment) return res.status(400).json({ message: "Comment is required" }); return res.json(await service.add(tutorId, studentId, comment)); } catch (err: any) { if (err instanceof service.TutorCommentError) return res.status(err.status).json({ message: err.message }); return sendInternalError(req, res, err, "routes.failed_to_add_comment", "Failed to add comment"); } }
