import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../lib/asyncHandler";
import * as controller from "./controller";

const RATE_LIMIT_MESSAGE = "Too many attempts. Please wait a few minutes and try again.";
function authRateLimitHandler(reason: string) {
  return (req: any, res: any) => {
    console.warn("[auth-rate-limit]", { route: req.route?.path || req.path || req.originalUrl.split("?")[0], method: req.method, ip: req.ip, reason });
    return res.status(429).json({ message: RATE_LIMIT_MESSAGE });
  };
}

const authSyncLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, handler: authRateLimitHandler("auth_sync_window_exceeded") });

export const router = Router();
router.post("/sync", authSyncLimiter, asyncHandler(controller.sync));
router.get("/me", asyncHandler(controller.me));
