import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

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

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

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

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/_health", (_req, res) => {
  res.status(200).send("ok");
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
      // Syllabus intelligence seed — idempotent. Failures are logged and
      // ignored so the server still boots if the seed dataset drifts.
      const { runCurriculumSeed } = await import("./scripts/seedCurriculum");
      await runCurriculumSeed({ quiet: false });
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
