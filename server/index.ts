import express, { type Request, Response, NextFunction } from "express";
import { execSync } from "child_process";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { log } from "./utils/logging";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
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

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
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

// Real DB liveness probe. Runs a `SELECT 1` against the actual pool
// and reports timing + pool stats so we can see whether Supabase is
// healthy, slow, or refusing connections.
app.get("/api/health/db", async (_req, res) => {
  const { db, pool } = await import("./db");
  if (!db || !pool) {
    return res.status(503).json({
      ok: false,
      reason: "db not initialised — connectDb() failed at startup",
    });
  }
  const start = Date.now();
  try {
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(sql`SELECT 1 AS ping, current_database() AS db, current_user AS usr, version() AS ver`);
    const elapsedMs = Date.now() - start;
    const row = (result as any).rows?.[0] ?? (result as any)[0] ?? {};
    res.json({
      ok: true,
      elapsedMs,
      db: row.db,
      user: row.usr,
      versionShort: typeof row.ver === "string" ? row.ver.slice(0, 60) : null,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    });
  } catch (e: any) {
    const elapsedMs = Date.now() - start;
    res.status(503).json({
      ok: false,
      elapsedMs,
      error: e?.message ?? String(e),
      code: e?.code,
      pool: pool ? {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      } : null,
    });
  }
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
        },
      });
    });

    app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      console.error("Internal Server Error:", err);

      if (res.headersSent) {
        return next(err);
      }

      return res.status(status).json({
        error: {
          code: err.code || `HTTP_${status}`,
          message,
          details: err.details || null,
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
