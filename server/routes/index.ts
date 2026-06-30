/**
 * Domain-route registration compatibility entry point.
 *
 * The legacy `server/routes.ts` still calls `registerDomainRoutes(app)` once at
 * the start of `registerRoutes()`. This file now delegates to the autoloaded
 * `server/modules` domain loader so newly extracted domains do not need to edit
 * a central manual import list.
 */
import type { Express } from "express";
import { registerDomainModules } from "../modules";

export async function registerDomainRoutes(app: Express): Promise<void> {
  await registerDomainModules(app);
}
