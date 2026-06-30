import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../lib/asyncHandler";
import * as controller from "./controller";

const RATE_LIMIT_MESSAGE = "Too many attempts. Please wait a few minutes and try again.";
function handler(reason: string) { return (req: any, res: any) => { console.warn("[auth-rate-limit]", { route: req.route?.path || req.path || req.originalUrl.split("?")[0], method: req.method, ip: req.ip, reason }); return res.status(429).json({ message: RATE_LIMIT_MESSAGE }); }; }
const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many reset requests. Please wait 15 minutes." } });
const verificationResendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: handler("verification_resend_window_exceeded") });
const verificationCodeSendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, handler: handler("verification_code_send_window_exceeded") });
const verificationCodeVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, handler: handler("verification_code_verify_window_exceeded") });

export const router = Router();
router.post("/forgot-password", forgotPasswordLimiter, asyncHandler(controller.forgotPassword));
router.post("/resend-verification", verificationResendLimiter, asyncHandler(controller.resend));
router.post("/send-verification-code", verificationCodeSendLimiter, asyncHandler(controller.sendCode));
router.post("/verify-verification-code", verificationCodeVerifyLimiter, asyncHandler(controller.verify));
