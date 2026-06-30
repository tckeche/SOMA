import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireTutor } from "../../middleware/roles";
import * as controller from "./controller";

export const router = Router();
router.post("/quizzes/:quizId/questions", requireTutor, asyncHandler(controller.addQuestions));
router.delete("/questions/:questionId", requireTutor, asyncHandler(controller.deleteQuestion));
