/**
 * Shared role middleware.
 *
 * Extracted from `server/routes.ts` so both the legacy monolith and the
 * new domain files under `server/routes/*` can share the exact same
 * middleware instances. Definitions are 1:1 with what was inline in
 * routes.ts; behaviour is unchanged.
 */
import type { NextFunction, Request, Response } from "express";
import { createRoleMiddleware, verifySupabaseToken } from "../auth";
import { storage } from "../storage";

export const requireTutor = createRoleMiddleware({
  allowedRoles: ["tutor", "super_admin"],
  identityHeaderName: "x-tutor-id",
  missingIdentityMessage: "Tutor ID required",
  forbiddenMessage: "Access denied: tutor role required",
  requestIdKey: "tutorId",
  requestUserKey: "tutorUser",
});

export const requireSuperAdmin = createRoleMiddleware({
  allowedRoles: ["super_admin"],
  identityHeaderName: "x-admin-id",
  missingIdentityMessage: "Admin ID required",
  forbiddenMessage: "Access denied: super_admin role required",
  requestIdKey: "adminId",
  requestUserKey: "adminUser",
});

/**
 * Supabase JWT authentication middleware.
 * Verifies the Bearer token from the Authorization header using the Supabase
 * JWT secret, extracts the user ID (sub claim), looks up the user in
 * soma_users, and attaches `req.authUser` with { id, email, role }.
 */
export function requireSupabaseAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const token = authHeader.slice(7);

  verifySupabaseToken(token)
    .then((decoded) => {
      if (!decoded) {
        return res.status(401).json({ message: "Invalid or expired token" });
      }
      const userId = decoded.sub;
      storage
        .getSomaUserById(userId)
        .then((user) => {
          if (!user) {
            return res.status(401).json({ message: "User not found" });
          }
          (req as any).authUser = {
            id: user.id,
            email: user.email,
            role: user.role,
            displayName: user.displayName,
          };
          next();
        })
        .catch(() => {
          res.status(500).json({ message: "Failed to verify user identity" });
        });
    })
    .catch(() => {
      res.status(401).json({ message: "Invalid or expired token" });
    });
}
