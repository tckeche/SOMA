import crypto from "node:crypto";
import { storage } from "../../storage";
import { logError, requestLogContext } from "../../utils/logging";
import { canonicalEmail, hashCode, make7DigitCode } from "./validators";
import { hashEmailForLog } from "../authAccount/validators";

const verificationResendAttempts = new Map<string, number>();
const verificationCodeStore = new Map<string, { id: string; codeHash: string; salt: string; expiresAt: number; usedAt: number | null; sentAt: number; attempts: number }>();

export class VerificationHttpError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown>) { super(message); }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function trustedSupabaseAuthUrl(): string | undefined {
  const raw = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) return parsed.origin;
  } catch {
    return undefined;
  }
  return undefined;
}

function supabaseAuthEndpoint(baseUrl: string, pathname: string, searchParams?: Record<string, string | number>): string {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(searchParams ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

export async function requestPasswordReset(rawEmail: unknown) {
  if (!rawEmail || typeof rawEmail !== "string") throw new VerificationHttpError(400, "Email is required", { error: "Email is required" });
  const normalised = rawEmail.trim().toLowerCase();
  const user = await storage.getSomaUserByEmail(normalised);
  if (user) await storage.logPasswordResetRequest(normalised);
  return { message: "If that email is registered, a reset link has been sent." };
}

export async function resendVerification(req: any) {
  const email = canonicalEmail(String(req.body?.email || ""));
  if (!email) throw new VerificationHttpError(400, "Email is required", { message: "Email is required", code: "VERIFICATION_EMAIL_REQUIRED" });
  const supabaseUrl = trustedSupabaseAuthUrl();
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new VerificationHttpError(500, "Verification service unavailable", { message: "Verification service unavailable", code: "VERIFICATION_CONFIG_MISSING" });
  const resp = await fetch(supabaseAuthEndpoint(supabaseUrl, "/auth/v1/resend"), { method: "POST", signal: AbortSignal.timeout(12_000), headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` }, body: JSON.stringify({ type: "signup", email }) });
  const body = await resp.text();
  if (!resp.ok) {
    logError("route.verification_resend_failed", undefined, { ...requestLogContext(req), severity: "medium", module: "routes", component: "verificationResend", emailHash: hashEmailForLog(email), status: resp.status, responseBody: body.slice(0, 220) });
    throw new VerificationHttpError(502, "Could not resend verification email. Please try again shortly.", { message: "Could not resend verification email. Please try again shortly.", code: "VERIFICATION_RESEND_FAILED" });
  }
  const attemptCount = (verificationResendAttempts.get(email) ?? 0) + 1;
  verificationResendAttempts.set(email, attemptCount);
  return { ok: true, attemptCount, canUseCodeFallback: attemptCount >= 3 };
}

export async function sendVerificationCode(rawEmail: unknown) {
  const email = canonicalEmail(String(rawEmail || ""));
  if (!email) throw new VerificationHttpError(400, "Email is required", { message: "Email is required", code: "VERIFICATION_EMAIL_REQUIRED" });
  const resendAttempts = verificationResendAttempts.get(email) ?? 0;
  if (resendAttempts < 3) throw new VerificationHttpError(403, "Fallback code unlocks after 3 failed resend attempts", { message: "Fallback code unlocks after 3 failed resend attempts", code: "VERIFICATION_CODE_NOT_ELIGIBLE" });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new VerificationHttpError(500, "Code delivery unavailable", { message: "Code delivery unavailable", code: "VERIFICATION_CODE_DELIVERY_UNAVAILABLE" });
  const now = Date.now();
  const existing = verificationCodeStore.get(email);
  if (existing && now - existing.sentAt < 60_000) throw new VerificationHttpError(429, "Please wait before requesting another code.", { message: "Please wait before requesting another code.", code: "VERIFICATION_CODE_RATE_LIMIT" });
  const code = make7DigitCode();
  const salt = crypto.randomBytes(16).toString("hex");
  const id = crypto.randomUUID();
  verificationCodeStore.set(email, { id, codeHash: hashCode(code, salt), salt, sentAt: now, expiresAt: now + 10 * 60_000, usedAt: null, attempts: 0 });
  const sendResp = await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(12_000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || "SOMA <onboarding@resend.dev>", to: [email], subject: "Your SOMA verification code", html: `<p>Your SOMA verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes and can be used once.</p>` }) });
  if (!sendResp.ok) {
    verificationCodeStore.delete(email);
    throw new VerificationHttpError(502, "Could not send verification code email.", { message: "Could not send verification code email.", code: "VERIFICATION_CODE_SEND_FAILED" });
  }
  return { ok: true, expiresInSeconds: 600 };
}

export async function verifyCode(rawEmail: unknown, rawCode: unknown) {
  const email = canonicalEmail(String(rawEmail || ""));
  const code = String(rawCode || "").trim();
  if (!email || !/^\d{7}$/.test(code)) throw new VerificationHttpError(400, "Valid email and 7-digit code required", { message: "Valid email and 7-digit code required", code: "VERIFICATION_CODE_INVALID_INPUT" });
  const record = verificationCodeStore.get(email);
  if (!record) throw new VerificationHttpError(404, "No active code found. Request a new code.", { message: "No active code found. Request a new code.", code: "VERIFICATION_CODE_NOT_FOUND" });
  if (record.usedAt) throw new VerificationHttpError(409, "This code has already been used.", { message: "This code has already been used.", code: "VERIFICATION_CODE_USED" });
  if (Date.now() > record.expiresAt) throw new VerificationHttpError(410, "This code has expired. Request a new code.", { message: "This code has expired. Request a new code.", code: "VERIFICATION_CODE_EXPIRED" });
  if (record.attempts >= 5) throw new VerificationHttpError(429, "Too many invalid attempts. Request a new code.", { message: "Too many invalid attempts. Request a new code.", code: "VERIFICATION_CODE_BRUTEFORCE_LOCK" });
  record.attempts += 1;
  if (hashCode(code, record.salt) !== record.codeHash) {
    verificationCodeStore.set(email, record);
    throw new VerificationHttpError(401, "Invalid code. Please check and try again.", { message: "Invalid code. Please check and try again.", code: "VERIFICATION_CODE_MISMATCH" });
  }
  const supabaseUrl = trustedSupabaseAuthUrl();
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) throw new VerificationHttpError(500, "Server verification config missing", { message: "Server verification config missing", code: "VERIFICATION_ADMIN_CONFIG_MISSING" });
  let targetUserId = "";
  for (let page = 1; page <= 5 && !targetUserId; page += 1) {
    const usersResp = await fetch(supabaseAuthEndpoint(supabaseUrl, "/auth/v1/admin/users", { page, per_page: 200 }), { headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` } });
    if (!usersResp.ok) break;
    const usersData = await usersResp.json();
    const users = Array.isArray(usersData?.users) ? usersData.users : [];
    const matched = users.find((u: any) => canonicalEmail(String(u.email || "")) === email);
    if (matched?.id) targetUserId = matched.id;
  }
  if (!targetUserId) throw new VerificationHttpError(404, "Account not found for this email", { message: "Account not found for this email", code: "VERIFICATION_USER_NOT_FOUND" });
  const encodedUserId = encodeURIComponent(targetUserId);
  const confirmResp = await fetch(supabaseAuthEndpoint(supabaseUrl, `/auth/v1/admin/users/${encodedUserId}`), { method: "PUT", headers: { "Content-Type": "application/json", apikey: serviceRole, Authorization: `Bearer ${serviceRole}` }, body: JSON.stringify({ email_confirm: true }) });
  if (!confirmResp.ok) throw new VerificationHttpError(502, "Could not confirm account from code.", { message: "Could not confirm account from code.", code: "VERIFICATION_CONFIRM_FAILED" });
  record.usedAt = Date.now();
  verificationCodeStore.set(email, record);
  return { ok: true, message: "Code accepted. Your email is now verified. You can log in." };
}
