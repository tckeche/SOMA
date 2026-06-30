import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireTutor } from "../../middleware/roles";
import * as controller from "./controller";

export const router = Router();
router.post("/:quizId/questions", requireTutor, asyncHandler(controller.addQuestions));
