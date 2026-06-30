import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import * as service from "./service";
import { requireSomaQuizReadAccess } from "./policies";
import type { SomaReadAuthUser } from "./types";
import { parseQuizId } from "./validators";

function authUser(req: Request) { return (req as any).authUser as SomaReadAuthUser; }
function sendDomain(res: Response, err: service.StudentQuizTakingError) { return res.status(err.status).json({ message: err.message }); }

export async function listQuizzes(req: Request, res: Response) {
  try {
    return res.json(await service.listQuizzes(authUser(req)));
  } catch (err: any) {
    return sendInternalError(req, res, err, "soma.quizzes.list", "Something went wrong while loading quizzes. Please try again.");
  }
}

export async function getQuiz(req: Request, res: Response) {
  let quizId: number;
  try { quizId = parseQuizId(req.params.id); } catch { return res.status(400).json({ message: "Invalid quiz ID" }); }
  try {
    const quiz = await service.getQuiz(quizId);
    if (!(await requireSomaQuizReadAccess(req, res, quiz))) return;
    return res.json(quiz);
  } catch (err: any) {
    if (err instanceof service.StudentQuizTakingError) return sendDomain(res, err);
    return sendInternalError(req, res, err, "soma.quizzes.get", "Something went wrong while loading this quiz. Please try again.");
  }
}

export async function getQuestions(req: Request, res: Response) {
  let quizId: number;
  try { quizId = parseQuizId(req.params.id); } catch { return res.status(400).json({ message: "Invalid quiz ID" }); }
  try {
    const quiz = await service.getQuiz(quizId);
    if (!(await requireSomaQuizReadAccess(req, res, quiz))) return;
    return res.json(await service.getQuestions(quizId));
  } catch (err: any) {
    if (err instanceof service.StudentQuizTakingError) return sendDomain(res, err);
    return sendInternalError(req, res, err, "soma.quizzes.questions", "Something went wrong while loading this quiz. Please try again.");
  }
}

export async function checkSubmission(req: Request, res: Response) {
  let quizId: number;
  try { quizId = parseQuizId(req.params.id, "quizId required"); } catch { return res.status(400).json({ message: "quizId required" }); }
  try {
    const studentId = String((req as any).authUser.id);
    return res.json(await service.checkSubmission(quizId, studentId));
  } catch (err: any) {
    return sendInternalError(req, res, err, "soma.quizzes.checkSubmission", "Something went wrong while checking your submission. Please try again.");
  }
}
