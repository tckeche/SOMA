import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireSupabaseAuth } from "../../middleware/roles";
import * as controller from "./controller";

export const router = Router();
router.get("/quizzes", requireSupabaseAuth, asyncHandler(controller.listQuizzes));
router.get("/quizzes/:id", requireSupabaseAuth, asyncHandler(controller.getQuiz));
router.get("/quizzes/:id/questions", requireSupabaseAuth, asyncHandler(controller.getQuestions));
router.get("/quizzes/:id/check-submission", requireSupabaseAuth, asyncHandler(controller.checkSubmission));
