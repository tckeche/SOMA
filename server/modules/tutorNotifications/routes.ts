import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireTutor } from "../../middleware/roles";
import * as controller from "./controller";
export const router = Router();
router.get("/", requireTutor, asyncHandler(controller.list));
router.post("/:id/read", requireTutor, asyncHandler(controller.markRead));
