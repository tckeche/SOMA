import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { storage } from "./storage";

export type AppRole = "student" | "tutor" | "super_admin";

type RequestUser = {
  id: string;
  email: string;
  role: AppRole;
  displayName: string | null;
};

type RoleMiddlewareConfig = {
  allowedRoles: AppRole[];
  identityHeaderName: "x-tutor-id" | "x-admin-id";
  missingIdentityMessage: string;
  forbiddenMessage: string;
  requestIdKey: "tutorId" | "adminId";
  requestUserKey: "tutorUser" | "adminUser";
};

type AuthLogSeverity = "low" | "medium" | "high";

type AuthLogContext = {
  requestId?: string;
  role?: string;
  userId?: string;
  tokenFingerprint?: string;
  reason?: string;
};

type TokenAuthFailureReason = "invalid_token" | "user_not_found" | "role_mismatch";

type TokenAuthResult =
  | { status: "authorized"; user: RequestUser }
  | { status: TokenAuthFailureReason; userId?: string; role?: string };

const invalidTokenAttempts = new Map<string, { count: number; firstSeen: number }>();
const INVALID_TOKEN_WINDOW_MS = 15 * 60 * 1000;
const MEDIUM_INVALID_TOKEN_ATTEMPTS = 3;
const HIGH_INVALID_TOKEN_ATTEMPTS = 10;

function getSupabaseJwtSecret(): string {
  return process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "";
}

export function getAuthRequestId(req: Request): string | undefined {
  const headerRequestId = req.headers["x-request-id"];
  if (Array.isArray(headerRequestId)) return headerRequestId[0];
  return headerRequestId || (req as any).id;
}

export function safeUserId(userId: string | undefined | null): string | undefined {
  if (!userId) return undefined;
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function classifyInvalidToken(fingerprint: string): AuthLogSeverity {
  const now = Date.now();
  const previous = invalidTokenAttempts.get(fingerprint);
  const current =
    previous && now - previous.firstSeen <= INVALID_TOKEN_WINDOW_MS
      ? { count: previous.count + 1, firstSeen: previous.firstSeen }
      : { count: 1, firstSeen: now };

  invalidTokenAttempts.set(fingerprint, current);

  if (current.count >= HIGH_INVALID_TOKEN_ATTEMPTS) return "high";
  if (current.count >= MEDIUM_INVALID_TOKEN_ATTEMPTS) return "medium";
  return "low";
}

export function logAuthEvent(
  req: Request,
  event: string,
  severity: AuthLogSeverity,
  context: AuthLogContext = {},
) {
  const payload = {
    event,
    severity,
    route: req.originalUrl || req.url,
    method: req.method,
    requestId: context.requestId ?? getAuthRequestId(req),
    role: context.role,
    userId: safeUserId(context.userId),
    tokenFingerprint: context.tokenFingerprint,
    reason: context.reason,
  };

  const log = severity === "high" ? console.error : severity === "medium" ? console.warn : console.info;
  log("[auth]", payload);
}

export function classifyAndLogInvalidToken(req: Request, token: string, reason = "invalid_or_expired_token") {
  const fingerprint = tokenFingerprint(token);
  const severity = classifyInvalidToken(fingerprint);
  logAuthEvent(req, "invalid_bearer_token", severity, { tokenFingerprint: fingerprint, reason });
}

export function parseCookies(req: Request) {
  const raw = req.headers.cookie;
  if (!raw) return {} as Record<string, string>;
  return raw.split(";").reduce<Record<string, string>>((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return acc;
    const key = pair.slice(0, idx).trim();
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    acc[key] = value;
    return acc;
  }, {});
}

export async function verifySupabaseToken(
  token: string,
): Promise<{ sub: string; email?: string; metadataName?: string } | null> {
  const secret = getSupabaseJwtSecret();
  if (secret) {
    try {
      const decoded = jwt.verify(token, secret) as {
        sub?: string;
        email?: string;
        user_metadata?: { display_name?: string; full_name?: string; name?: string };
      };
      if (decoded.sub) {
        return {
          sub: decoded.sub,
          email: decoded.email,
          metadataName: extractMetadataName(decoded.user_metadata),
        };
      }
    } catch {}
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) return null;

  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, apikey: process.env.VITE_SUPABASE_ANON_KEY || "" },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (user?.id) return { sub: user.id, email: user.email, metadataName: extractMetadataName(user.user_metadata) };
  } catch {}

  return null;
}

function extractMetadataName(
  meta: { display_name?: string; full_name?: string; name?: string } | undefined,
): string | undefined {
  const name = (meta?.display_name || meta?.full_name || meta?.name || "").trim();
  return name || undefined;
}

function getBearerToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7);
}

async function findAuthorizedUserByToken(token: string, allowedRoles: AppRole[]): Promise<TokenAuthResult> {
  const decoded = await verifySupabaseToken(token);
  if (!decoded?.sub) return { status: "invalid_token" };
  const user = await storage.getSomaUserById(decoded.sub);
  if (!user) return { status: "user_not_found", userId: decoded.sub };
  if (!allowedRoles.includes(user.role as AppRole)) {
    return { status: "role_mismatch", userId: user.id, role: user.role };
  }
  return {
    status: "authorized",
    user: { id: user.id, email: user.email, role: user.role as AppRole, displayName: user.displayName ?? null },
  };
}

async function findAuthorizedUserByHeader(
  req: Request,
  headerName: RoleMiddlewareConfig["identityHeaderName"],
  allowedRoles: AppRole[],
): Promise<RequestUser | null> {
  const rawUserId = req.headers[headerName] as string | undefined;
  if (!rawUserId) return null;
  const user = await storage.getSomaUserById(rawUserId);
  if (!user || !allowedRoles.includes(user.role as AppRole)) return null;
  return { id: user.id, email: user.email, role: user.role as AppRole, displayName: user.displayName ?? null };
}

function attachAuthenticatedUser(req: Request, user: RequestUser) {
  (req as any).authUser = {
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
  };
}

export function getAdminSessionToken(req: Request, adminCookieName: string) {
  return parseCookies(req)[adminCookieName] || "";
}

export function createRoleMiddleware(config: RoleMiddlewareConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bearerToken = getBearerToken(req);
      const bearerResult = bearerToken
        ? await findAuthorizedUserByToken(bearerToken, config.allowedRoles)
        : null;

      if (bearerResult?.status === "authorized") {
        const bearerUser = bearerResult.user;
        attachAuthenticatedUser(req, bearerUser);
        (req as any)[config.requestIdKey] = bearerUser.id;
        (req as any)[config.requestUserKey] = bearerUser;
        return next();
      }

      if (!bearerToken) {
        logAuthEvent(req, "missing_bearer_token", "low");
      } else if (bearerResult?.status === "invalid_token") {
        classifyAndLogInvalidToken(req, bearerToken);
      } else if (bearerResult?.status === "user_not_found") {
        logAuthEvent(req, "user_not_found", "medium", { userId: bearerResult.userId });
      } else if (bearerResult?.status === "role_mismatch") {
        logAuthEvent(req, "role_mismatch", config.allowedRoles.includes("super_admin") ? "high" : "medium", {
          role: bearerResult.role,
          userId: bearerResult.userId,
        });
      }

      // Header-based identity is a legacy fallback for local/dev setups only.
      // In production this must stay disabled to prevent header spoofing.
      if (process.env.NODE_ENV === "production") {
        return res.status(401).json({ message: "Authentication required" });
      }

      const headerUser = await findAuthorizedUserByHeader(req, config.identityHeaderName, config.allowedRoles);
      if (!headerUser) {
        const missingIdentity = !(req.headers[config.identityHeaderName] as string | undefined);
        return res.status(missingIdentity ? 401 : 403).json({
          message: missingIdentity ? config.missingIdentityMessage : config.forbiddenMessage,
        });
      }

      logAuthEvent(req, "legacy_header_fallback_used", "medium", {
        role: headerUser.role,
        userId: headerUser.id,
      });
      attachAuthenticatedUser(req, headerUser);
      (req as any)[config.requestIdKey] = headerUser.id;
      (req as any)[config.requestUserKey] = headerUser;
      return next();
    } catch {
      return res.status(500).json({ message: "Failed to verify user identity" });
    }
  };
}

export async function getAuthorizedUserFromBearer(token: string, allowedRoles: AppRole[]): Promise<RequestUser | null> {
  const result = await findAuthorizedUserByToken(token, allowedRoles);
  return result.status === "authorized" ? result.user : null;
}
