import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { storage } from "./storage";
import { logError, logSecurity, requestLogContext } from "./utils/logging";

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

function getSupabaseJwtSecret(): string {
  return process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "";
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

async function findAuthorizedUserByToken(token: string, allowedRoles: AppRole[]): Promise<RequestUser | null> {
  const decoded = await verifySupabaseToken(token);
  if (!decoded?.sub) return null;
  const user = await storage.getSomaUserById(decoded.sub);
  if (!user || !allowedRoles.includes(user.role as AppRole)) return null;
  return { id: user.id, email: user.email, role: user.role as AppRole, displayName: user.displayName ?? null };
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
      const bearerUser = bearerToken
        ? await findAuthorizedUserByToken(bearerToken, config.allowedRoles)
        : null;

      if (bearerUser) {
        attachAuthenticatedUser(req, bearerUser);
        (req as any)[config.requestIdKey] = bearerUser.id;
        (req as any)[config.requestUserKey] = bearerUser;
        return next();
      }

      // Header-based identity is a legacy fallback for local/dev setups only.
      // In production this must stay disabled to prevent header spoofing.
      if (process.env.NODE_ENV === "production") {
        logSecurity("auth.header_fallback_blocked", {
          ...requestLogContext(req as any),
          module: "auth",
          component: "roleMiddleware",
          allowedRoles: config.allowedRoles,
        });
        return res.status(401).json({ message: "Authentication required" });
      }

      const headerUser = await findAuthorizedUserByHeader(req, config.identityHeaderName, config.allowedRoles);
      if (!headerUser) {
        const missingIdentity = !(req.headers[config.identityHeaderName] as string | undefined);
        logSecurity(missingIdentity ? "auth.identity_missing" : "auth.role_forbidden", {
          ...requestLogContext(req as any),
          module: "auth",
          component: "roleMiddleware",
          severity: missingIdentity ? "medium" : "high",
          identityHeaderName: config.identityHeaderName,
          allowedRoles: config.allowedRoles,
        });
        return res.status(missingIdentity ? 401 : 403).json({
          message: missingIdentity ? config.missingIdentityMessage : config.forbiddenMessage,
        });
      }

      attachAuthenticatedUser(req, headerUser);
      (req as any)[config.requestIdKey] = headerUser.id;
      (req as any)[config.requestUserKey] = headerUser;
      return next();
    } catch (err) {
      logError("auth.identity_verification_failed", err, {
        ...requestLogContext(req as any),
        severity: "high",
        module: "auth",
        component: "roleMiddleware",
        allowedRoles: config.allowedRoles,
      });
      return res.status(500).json({ message: "Failed to verify user identity" });
    }
  };
}

export async function getAuthorizedUserFromBearer(token: string, allowedRoles: AppRole[]): Promise<RequestUser | null> {
  return findAuthorizedUserByToken(token, allowedRoles);
}
