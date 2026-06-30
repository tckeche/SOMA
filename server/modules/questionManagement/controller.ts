import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import * as service from "./service";
import { parseQuestionId, parseQuizId } from "./validators";

function tutorId(req: Request) { return (req as any).tutorId as string; }
function sendDomain(res: Response, err: service.QuestionManagementError) { return res.status(err.status).json({ message: err.message }); }

export async function addQuestions(req: Request, res: Response) {
  let quizId: number;
  try {
    quizId = parseQuizId(req.params.quizId);
  } catch {
    return res.status(400).json({ message: "Invalid quiz ID" });
  }
  try {
    return res.json(await service.addQuestions(quizId, tutorId(req), req.body?.questions));
  } catch (err: any) {
    if (err instanceof service.QuestionManagementError) return sendDomain(res, err);
    return sendInternalError(req, res, err, "routes.failed_to_add_questions", "Failed to add questions");
  }
}

export async function deleteQuestion(req: Request, res: Response) {
  let questionId: number;
  try {
    questionId = parseQuestionId(req.params.questionId);
  } catch {
    return res.status(400).json({ message: "Invalid question ID" });
  }
  try {
    return res.json(await service.deleteQuestion(questionId, tutorId(req)));
  } catch (err: any) {
    if (err instanceof service.QuestionManagementError) return sendDomain(res, err);
    return sendInternalError(req, res, err, "routes.failed_to_delete_question", "Failed to delete question");
  }
}
