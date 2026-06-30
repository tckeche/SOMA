import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireSupabaseAuth } from "../../middleware/roles";
import * as controller from "./controller";
const graphRenderLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
export const router = Router();
router.post("/render-svg", graphRenderLimiter, requireSupabaseAuth, asyncHandler(controller.renderSvg));
