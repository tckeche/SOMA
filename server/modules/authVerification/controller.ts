import type { Request, Response } from "express";
import { logError, requestLogContext } from "../../utils/logging";
import { requestPasswordReset, resendVerification, sendVerificationCode, verifyCode, VerificationHttpError } from "./service";

function sendVerificationError(res: Response, err: VerificationHttpError) { return res.status(err.status).json(err.body); }

export async function forgotPassword(req: Request, res: Response) {
  try { return res.json(await requestPasswordReset(req.body?.email)); }
  catch (err: any) {
    if (err instanceof VerificationHttpError) return sendVerificationError(res, err);
    logError("route.forgot_password_failed", err, { ...requestLogContext(req as any), severity: "high", module: "routes", component: "forgotPassword" });
    return res.status(500).json({ error: "Failed to process password reset request." });
  }
}
export async function resend(req: Request, res: Response) {
  try { return res.json(await resendVerification(req)); }
  catch (err: any) { if (err instanceof VerificationHttpError) return sendVerificationError(res, err); return res.status(500).json({ message: "Verification resend failed", code: "VERIFICATION_RESEND_EXCEPTION" }); }
}
export async function sendCode(req: Request, res: Response) {
  try { return res.json(await sendVerificationCode(req.body?.email)); }
  catch (err: any) { if (err instanceof VerificationHttpError) return sendVerificationError(res, err); console.error("[verification-code-send-error]", err?.message || err); return res.status(500).json({ message: "Could not send verification code", code: "VERIFICATION_CODE_SEND_EXCEPTION" }); }
}
export async function verify(req: Request, res: Response) {
  try { return res.json(await verifyCode(req.body?.email, req.body?.code)); }
  catch (err: any) { if (err instanceof VerificationHttpError) return sendVerificationError(res, err); console.error("[verification-code-verify-error]", err?.message || err); return res.status(500).json({ message: "Code verification failed", code: "VERIFICATION_CODE_VERIFY_EXCEPTION" }); }
}
