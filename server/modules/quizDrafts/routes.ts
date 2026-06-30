import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireTutor } from "../../middleware/roles";
import * as controller from "./controller";
export const router = Router();
router.get("/:quizId/draft", requireTutor, asyncHandler(controller.getDraft));
router.put("/:quizId/draft", requireTutor, asyncHandler(controller.putDraft));
