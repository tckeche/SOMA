import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireSupabaseAuth } from "../../middleware/roles";
import * as controller from "./controller";
export const router = Router();
router.post("/client-error", requireSupabaseAuth, asyncHandler(controller.report));
