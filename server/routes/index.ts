/**
 * Domain-route registration compatibility entry point.
 *
 * The legacy `server/routes.ts` still calls `registerDomainRoutes(app)` once at
 * the start of `registerRoutes()`. This file delegates to the autoloaded
 * `server/modules` domain loader (see server/modules/routerLoader.ts) so newly
 * extracted domains do not need to edit a central manual import list — they are
 * picked up from server/modules/* (filesystem discovery) or, in the bundled
 * production build, from server/modules/staticManifest.ts.
 *
 * IMPORTANT: this must remain a delegation to `registerDomainModules`. A prior
 * merge regression replaced it with a hand-maintained list that only registered
 * a subset of the legacy domains, which silently dropped every router-based
 * module (authAccount, pdfAttachments, pdfSubmissions, studentQuizTaking, …) and
 * made their routes 404 in both the app and the integration tests.
 */
import type { Express } from "express";
import { registerDomainModules } from "../modules";

export async function registerDomainRoutes(app: Express): Promise<void> {
  await registerDomainModules(app);
}
