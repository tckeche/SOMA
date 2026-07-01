/**
 * RATE-LIMIT COVERAGE (audit pin)
 *
 * Proves that the sensitive route surface is rate-limited. SOMA layers two
 * defences:
 *   1. Global per-prefix limiters mounted with app.use() BEFORE any domain
 *      module or inline handler is registered (so they cover module routes too).
 *   2. Dedicated per-route limiters on auth, AI, upload and grading routes.
 *
 * These assertions read the route source directly (the same static-analysis
 * style the phase*Routes tests use to confirm the monolith migration) so they
 * do not depend on fragile Express internal-stack positions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { staticDomainModules } from "../server/modules/staticManifest";

const routesSrc = readFileSync("server/routes.ts", "utf8");
const modSrc = (p: string) => readFileSync(`server/modules/${p}`, "utf8");
const LIMITER = /[A-Za-z]+Limiter\b/;

/** The middleware chain registered for a quoted route path: text from the route
 *  literal up to the start of its handler. Robust to single/multi-line. */
function chain(src: string, path: string): string {
  const i = src.indexOf(`"${path}"`);
  expect(i, `route "${path}" should be registered`).toBeGreaterThan(-1);
  const tail = src.slice(i);
  const marks = ["async (", "asyncHandler(", "=> {"].map((m) => tail.indexOf(m)).filter((n) => n >= 0);
  const end = marks.length ? Math.min(Math.min(...marks), 400) : 400;
  return tail.slice(0, end);
}

describe("rate-limit coverage", () => {
  it("mounts global per-prefix limiters ahead of the route handlers", () => {
    for (const mount of [
      'app.use("/api/admin", adminRateLimiter)',
      'app.use("/api/auth", authApiLimiter)',
      'app.use("/api/tutor", tutorApiLimiter)',
      'app.use("/api/super-admin", superAdminApiLimiter)',
      'app.use("/api/student", studentApiLimiter)',
      'app.use("/api/quizzes", studentApiLimiter)',
      'app.use("/api/soma", somaAiLimiter)',
    ]) {
      expect(routesSrc).toContain(mount);
    }
    // Prefix limiters must be registered before registerDomainRoutes() so they
    // also cover the autoloaded domain modules.
    expect(routesSrc.indexOf('app.use("/api/tutor", tutorApiLimiter)')).toBeLessThan(
      routesSrc.indexOf("await registerDomainRoutes(app)"),
    );
  });

  it("AI routes carry a dedicated AI limiter", () => {
    expect(chain(routesSrc, "/api/soma/generate")).toContain("legacyAdminAiLimiter");
    expect(chain(routesSrc, "/api/tutor/quizzes/generate")).toContain("tutorGenerationAiLimiter");
    expect(chain(routesSrc, "/api/tutor/copilot-chat")).toContain("tutorCopilotAiLimiter");
    expect(chain(routesSrc, "/api/tutor/ai/intervention-insights")).toContain("tutorAnalyticsAiLimiter");
    expect(chain(routesSrc, "/api/tutor/ai/student-summary")).toContain("tutorAnalyticsAiLimiter");
    expect(chain(routesSrc, "/api/tutor/students/:studentId/ai/suggested-assessments")).toContain("tutorAnalyticsAiLimiter");
    expect(chain(routesSrc, "/api/tutor/students/:studentId/ai/publish-suggested")).toContain("tutorAnalyticsAiLimiter");
    expect(chain(routesSrc, "/api/soma/global-tutor")).toContain("globalTutorAiLimiter");
    expect(chain(routesSrc, "/api/analyze-class")).toContain("analyzeClassLimiter");
  });

  it("auth + verification + login routes carry strict limiters", () => {
    expect(chain(routesSrc, "/api/admin/login")).toContain("loginLimiter");
    const av = modSrc("authVerification/routes.ts");
    expect(chain(av, "/forgot-password")).toMatch(LIMITER);
    expect(chain(av, "/resend-verification")).toMatch(LIMITER);
    expect(chain(av, "/send-verification-code")).toMatch(LIMITER);
    expect(chain(av, "/verify-verification-code")).toMatch(LIMITER);
  });

  it("upload routes carry an upload limiter", () => {
    expect(chain(routesSrc, "/api/upload-image")).toContain("uploadImageLimiter");
    // First occurrence of the attachments path = the POST upload route.
    expect(chain(modSrc("pdfAttachments/routes.ts"), "/api/tutor/quizzes/:quizId/attachments")).toMatch(LIMITER);
    expect(chain(modSrc("pdfSubmissions/routes.ts"), "/api/quizzes/:quizId/submission-upload")).toMatch(LIMITER);
  });

  it("grading / submission-mark route carries a limiter", () => {
    expect(chain(routesSrc, "/api/tutor/submission-uploads/:id/mark")).toContain("tutorApiLimiter");
  });

  it("staticManifest contains every expected domain module", () => {
    const names = staticDomainModules.map((m) => m.name);
    for (const name of [
      "authAccount", "authVerification", "clientDiagnostics", "graphRendering",
      "syllabusCatalogue", "tutorQuizzes", "quizAssignments", "tutorReports",
      "tutorDashboard", "tutorNotifications", "flaggedQuestions", "pdfAttachments",
      "pdfSubmissions", "quizDrafts", "quizPublish", "questionManagement",
      "studentQuizTaking", "studentSubjects", "tutorStudentComments",
    ]) {
      expect(names, `staticManifest missing ${name}`).toContain(name);
    }
  });

  it("does not re-declare any migrated route inline in the monolith", () => {
    for (const decl of [
      'app.post("/api/auth/sync"',
      'app.get("/api/tutor/quizzes"',
      'app.post("/api/tutor/quizzes/:quizId/assign"',
      'app.get("/api/tutor/quizzes/:quizId/detail"',
      'app.post("/api/tutor/quizzes/:quizId/questions"',
      'app.put("/api/tutor/quizzes/:quizId/draft"',
      'app.post("/api/tutor/quizzes/:quizId/publish"',
      'app.get("/api/quizzes/:quizId/attachments"',
      'app.post("/api/quizzes/:quizId/submission-upload"',
      'app.post("/api/graph/render-svg"',
      'app.delete("/api/tutor/questions/:questionId"',
    ]) {
      expect(routesSrc, `migrated route still inline: ${decl}`).not.toContain(decl);
    }
  });
});
