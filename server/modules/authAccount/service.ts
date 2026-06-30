import { insertSomaUserSchema } from "@shared/schema";
import { verifySupabaseToken } from "../../auth";
import { storage } from "../../storage";
import { logInfo, requestLogContext } from "../../utils/logging";
import { determineRole } from "./policies";
import type { AuthMetadata } from "./types";
import { hashEmailForLog } from "./validators";

export class AuthHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function isEmailDerivedName(name: string | null | undefined, email: string): boolean {
  const n = (name || "").trim().toLowerCase();
  if (!n) return true;
  return n === email.toLowerCase() || n === email.split("@")[0].toLowerCase();
}

function humanizeEmailPrefix(email: string): string {
  const words = email.split("@")[0].split(/[._\-+\d]+/).filter(Boolean);
  if (words.length === 0) return "Student";
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function resolveDisplayName(metadataName: string | null | undefined, existingName: string | null | undefined, email: string): string {
  const meta = (metadataName || "").trim();
  if (meta && !isEmailDerivedName(meta, email)) return meta;
  const existing = (existingName || "").trim();
  if (existing && !isEmailDerivedName(existing, email)) return existing;
  return humanizeEmailPrefix(email);
}

async function resolveIdentityFromAuth(req: any, bodyFallback: boolean, queryFallback = false) {
  let id = "";
  let email = "";
  let tokenName: string | undefined;
  let tokenRequestedRole: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const decoded = await verifySupabaseToken(authHeader.slice(7));
    if (!decoded?.sub || !decoded?.email) throw new AuthHttpError(401, "Invalid or expired token");
    id = decoded.sub;
    email = decoded.email;
    tokenName = decoded.metadataName;
    tokenRequestedRole = decoded.requestedRole;
  } else if (process.env.NODE_ENV !== "production") {
    id = String(queryFallback ? req.query.userId || "" : req.body?.id || "");
    email = String(queryFallback ? req.query.email || "" : req.body?.email || "");
  } else if (bodyFallback) {
    throw new AuthHttpError(401, "Authentication required");
  }
  return { id, email, tokenName, tokenRequestedRole };
}

export async function syncAccount(req: any, metadata?: AuthMetadata) {
  const { id, email, tokenName } = await resolveIdentityFromAuth(req, true);
  if (!id || !email) throw new AuthHttpError(400, "Missing id or email");

  const existingUser = await storage.getSomaUserById(id);
  const role = existingUser ? existingUser.role : determineRole(email, metadata?.requested_role);
  console.log("[auth-sync]", { emailHash: hashEmailForLog(email), role });
  const parsed = insertSomaUserSchema.parse({
    id,
    email,
    displayName: resolveDisplayName(metadata?.display_name || metadata?.full_name || tokenName, existingUser?.displayName, email),
    role,
  });
  const user = await storage.upsertSomaUser(parsed);
  const signupSubjects = Array.isArray(metadata?.subjects) && metadata.subjects.length > 0
    ? metadata.subjects
    : (metadata?.subject && metadata?.syllabus && metadata?.syllabus_code && metadata?.level)
      ? [{ subject: metadata.subject, examBody: metadata.syllabus, syllabusCode: metadata.syllabus_code, level: metadata.level }]
      : [];
  for (const item of signupSubjects) {
    if (!item.subject || !item.examBody || !item.syllabusCode || !item.level) continue;
    const existing = await storage.listStudentSubjects(user.id);
    const already = existing.some((s) => s.subject.toLowerCase() === item.subject.toLowerCase() && s.syllabusCode.toLowerCase() === item.syllabusCode.toLowerCase());
    if (!already) await storage.addStudentSubject({ studentId: user.id, subject: item.subject, examBody: item.examBody, syllabusCode: item.syllabusCode, level: item.level });
  }
  return user;
}

export async function getCurrentAccount(req: any) {
  const { id: userId, email, tokenName, tokenRequestedRole } = await resolveIdentityFromAuth(req, true, true);
  if (!userId || !email) throw new AuthHttpError(400, "userId required");
  let user = await storage.getSomaUserById(userId);
  if (!user) {
    const role = determineRole(email, tokenRequestedRole);
    logInfo("auth.auto_sync_missing_user", { ...requestLogContext(req), module: "routes", component: "authMe", userIdHash: hashEmailForLog(userId), role, emailHash: hashEmailForLog(email) });
    const parsed = insertSomaUserSchema.parse({ id: userId, email, displayName: resolveDisplayName(tokenName, null, email), role });
    user = await storage.upsertSomaUser(parsed);
  } else if (tokenName && isEmailDerivedName(user.displayName, user.email)) {
    user = await storage.upsertSomaUser({ id: user.id, email: user.email, displayName: resolveDisplayName(tokenName, user.displayName, user.email), role: user.role });
  }
  if (!user) throw new AuthHttpError(404, "User not found");
  await storage.touchUserLastLogin(user.id);
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}
