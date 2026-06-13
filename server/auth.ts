import type { NextFunction, Request, Response } from "express";
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

function getRequestPath(req: Request): string {
  return req.originalUrl || req.url || "unknown";
}

function warnNonProductionIdentityFallback(req: Request, role: AppRole) {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "non_production_identity_header_fallback_used",
      route: getRequestPath(req),
      method: req.method,
      role,
      message: "Legacy identity header fallback was used outside production; never enable this fallback in production.",
    }),
  );
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

      // Header-based identity is a legacy fallback for local/dev test setups only.
      // It trusts caller-supplied identity headers and must NEVER be enabled in production,
      // because doing so would allow header spoofing to bypass Supabase Bearer auth.
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

      warnNonProductionIdentityFallback(req, headerUser.role);
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
  return findAuthorizedUserByToken(token, allowedRoles);
}
