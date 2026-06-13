import express, { type Request, Response, NextFunction } from "express";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { log } from "./utils/logging";
import { recordRequestDiagnostics } from "./services/diagnosticsStore";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);
app.use(attachRequestId);
app.use(installErrorResponseFormatter);

app.use((req, res, next) => {
  const incomingRequestId = req.get("x-request-id")?.trim();
  req.requestId = incomingRequestId || randomUUID();
  res.setHeader("x-request-id", req.requestId);

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (req.path.startsWith("/api") && res.statusCode >= 400 && body && typeof body === "object") {
      const responseBody = body as { error?: unknown; requestId?: string };
      if (responseBody.error && typeof responseBody.error === "object") {
        responseBody.error = { ...(responseBody.error as Record<string, unknown>), requestId: req.requestId };
      } else if (responseBody.error) {
        responseBody.requestId = req.requestId;
      }
    }
    return originalJson(body);
  };

  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(JSON.stringify({ requestId: req.requestId, method: req.method, path, statusCode: res.statusCode, durationMs: duration }));
    }
  });

  next();
});

const resolvedCommitSha = (() => {
  if (process.env.GIT_COMMIT_SHA) return process.env.GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Returns the git commit SHA the running bundle was built from. Used
// to verify a deployment actually shipped the expected code — without
// this we can't tell whether the deployed bundle is on commit X or Y
// unless we read the bundle file directly. The SHA is injected at
// build time by script/build.ts via esbuild's `define`. At runtime in
// dev (tsx, no build step), it falls back to reading .git/HEAD so
// `npm run dev` still reports something useful.
app.get("/api/health/version", (_req, res) => {
  // __BUILD_COMMIT_SHA__ is replaced by esbuild at build time. The
  // typeof check works because esbuild substitutes the literal string,
  // and an unsubstituted reference would be a ReferenceError otherwise.
  let commit = "unknown";
  let buildTime = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — injected by esbuild
    commit = typeof __BUILD_COMMIT_SHA__ !== "undefined" ? __BUILD_COMMIT_SHA__ : "unknown";
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — injected by esbuild
    buildTime = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "unknown";
  } catch {
    // dev mode — fall through to .git read
  }
  if (commit === "unknown") {
    try {
      const fs = require("node:fs");
      const head = fs.readFileSync(".git/HEAD", "utf8").trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice("ref: ".length);
        commit = fs.readFileSync(`.git/${ref}`, "utf8").trim();
      } else {
        commit = head;
      }
    } catch {
      // .git not present (e.g. some deployment containers) — leave as "unknown"
    }
  }
  res.json({ commit, buildTime, runtime: "node", env: process.env.NODE_ENV ?? "unknown" });
});

app.get("/_health", (_req, res) => {
  res.status(200).send("ok");
});

// Returns the in-memory ring buffer of recent QUIZ_TRACE events so the
// deployed app's pipeline can be inspected via a curl from anywhere
// (workspace shell, browser, monitoring) — no Replit-UI log digging.
//
// Empty when QUIZ_TRACE is unset (the trace logger is a no-op then,
// so nothing reaches the buffer). Set QUIZ_TRACE=1 in deployment
// secrets, republish, generate a quiz, then GET /api/health/trace.
//
// Optional query params:
//   ?since=<ISO>   only return events with ts > since
//   ?limit=<n>     return only the most recent n events
//   ?clear=1       wipe the buffer (returns the events being wiped)
app.get("/api/health/trace", async (req, res) => {
  const { getRecentTraces, clearTraces } = await import("./services/quizTraceLog");
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
  const events = getRecentTraces({ since, limit: Number.isFinite(limit ?? NaN) ? limit : undefined });
  if (req.query.clear === "1") clearTraces();
  res.json({
    enabled: process.env.QUIZ_TRACE === "1" || process.env.QUIZ_TRACE === "true",
    eventCount: events.length,
    events,
  });
});

type DbHealthOptions = { diagnostics: boolean };

function poolSnapshot(pool: { totalCount: number; idleCount: number; waitingCount: number } | null | undefined) {
  return pool
    ? {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }
    : null;
}

function logDbHealthFailure(details: Record<string, unknown>) {
  console.error(JSON.stringify({
    level: "error",
    event: "db_health_check_failed",
    timestamp: new Date().toISOString(),
    ...details,
  }));
}

async function runDbHealthCheck({ diagnostics }: DbHealthOptions) {
  const { db, pool } = await import("./db");
  const start = Date.now();

  if (!db || !pool) {
    return sendApiError(_req, res, {
      status: 503,
      code: "DB_NOT_INITIALISED",
      message: "The database is not ready. Please try again shortly.",
      details: { reason: "db not initialised — connectDb() failed at startup" },
    });
    return {
      statusCode: 503,
      body: diagnostics
        ? { ok: false, elapsedMs, status: "unavailable", reason: "db_not_initialised", pool: poolSnapshot(pool) }
        : { ok: false, elapsedMs, status: "unavailable", message: "Database health check failed" },
    };
  }

  try {
    const { sql } = await import("drizzle-orm");
    const query = diagnostics
      ? sql`SELECT 1 AS ping, current_database() AS db, current_user AS usr, version() AS ver`
      : sql`SELECT 1 AS ping`;
    const result = await db.execute(query);
    const elapsedMs = Date.now() - start;
    const row = (result as any).rows?.[0] ?? (result as any)[0] ?? {};

    return {
      statusCode: 200,
      body: diagnostics
        ? {
          ok: true,
          elapsedMs,
          status: "ok",
          db: row.db,
          user: row.usr,
          versionShort: typeof row.ver === "string" ? row.ver.slice(0, 60) : null,
          pool: poolSnapshot(pool),
        }
        : { ok: true, elapsedMs, status: "ok" },
    };
  } catch (e: any) {
    const elapsedMs = Date.now() - start;
    sendApiError(_req, res, {
      status: 503,
      code: e?.code || "DB_HEALTH_CHECK_FAILED",
      message: "The database health check failed. Please try again shortly.",
      details: {
        elapsedMs,
        reason: e?.message ?? String(e),
        pool: pool ? {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        } : null,
      },
    });

    return {
      statusCode: 503,
      body: diagnostics
        ? {
          ok: false,
          elapsedMs,
          status: "unavailable",
          error: e?.message ?? String(e),
          code: e?.code,
          pool: poolSnapshot(pool),
        }
        : { ok: false, elapsedMs, status: "unavailable", message: "Database health check failed" },
    };
  }
}

// Public DB liveness probe. Keep unauthenticated output intentionally minimal
// so operational details are only exposed through super-admin diagnostics.
app.get("/api/health/db", async (_req, res) => {
  const result = await runDbHealthCheck({ diagnostics: false });
  res.status(result.statusCode).json(result.body);
});

// Super-admin-only DB diagnostics with database, user, version, pool, and error-code details.
app.get("/api/super-admin/health/db", requireSuperAdmin, async (_req, res) => {
  const result = await runDbHealthCheck({ diagnostics: true });
  res.status(result.statusCode).json(result.body);
});

const port = parseInt(process.env.PORT || "5000", 10);

(async () => {
  try {
    {
      const { connectDb } = await import("./db");
      await connectDb();
      const { initStorage } = await import("./storage");
      initStorage();
      const { applyBootstrapMigrations } = await import("./bootstrap");
      await applyBootstrapMigrations();
    }

    await registerRoutes(httpServer, app);

    app.use("/api/{*path}", (req, res) => {
      res.status(404).json({
        error: {
          code: "API_NOT_FOUND",
          message: `No API route for ${req.method} ${req.path}`,
          details: null,
          requestId: req.requestId,
        },
      });
    });

    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      console.error("Internal Server Error:", { requestId: req.requestId, error: err });

      if (res.headersSent) {
        return next(err);
      }

      return res.status(status).json({
        error: {
          code: err.code || `HTTP_${status}`,
          message,
          details: err.details || null,
          requestId: req.requestId,
        },
      });
    });

    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    } else {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }

    // Start listening only after everything is fully initialised —
    // this prevents "Cannot GET /" during the startup window.
    httpServer.listen(
      { port, host: "0.0.0.0", reusePort: true },
      () => { log(`serving on port ${port}`); },
    );
  } catch (err) {
    console.error("Fatal error during server initialization:", err);
    process.exit(1);
  }
})();
