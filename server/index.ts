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
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
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
httpServer.listen(
  {
    port,
    host: "0.0.0.0",
    reusePort: true,
  },
  () => {
    log(`serving on port ${port}`);
  },
);

(async () => {
  try {
    {
      const { connectDb } = await import("./db");
      await connectDb();
      const { initStorage } = await import("./storage");
      initStorage();
      const { pool: pgPool } = await import("./db");
      const client = pgPool ? await pgPool.connect() : null;
      if (client) {
        try {
          await client.query(`ALTER TABLE soma_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student'`);
          await client.query(`ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES soma_users(id) ON DELETE SET NULL`);
          await client.query(`ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false`);
          await client.query(`ALTER TABLE soma_quizzes ADD COLUMN IF NOT EXISTS time_limit_minutes INTEGER NOT NULL DEFAULT 60`);
          await client.query(`CREATE TABLE IF NOT EXISTS tutor_students (id SERIAL PRIMARY KEY, tutor_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`);
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tutor_student_unique_idx ON tutor_students(tutor_id, student_id)`);
          await client.query(`CREATE TABLE IF NOT EXISTS quiz_assignments (id SERIAL PRIMARY KEY, quiz_id INTEGER NOT NULL REFERENCES soma_quizzes(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`);
          await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS quiz_assignment_unique_idx ON quiz_assignments(quiz_id, student_id)`);
          await client.query(`CREATE TABLE IF NOT EXISTS tutor_comments (id SERIAL PRIMARY KEY, tutor_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, student_id UUID NOT NULL REFERENCES soma_users(id) ON DELETE CASCADE, comment TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`);
          await client.query(`ALTER TABLE quiz_assignments ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ`);
          await client.query(`ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`);
          await client.query(`ALTER TABLE soma_reports ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`);
          await client.query(`UPDATE soma_reports SET student_name = su.display_name FROM soma_users su WHERE soma_reports.student_id = su.id AND su.display_name IS NOT NULL AND su.display_name != '' AND soma_reports.student_name != su.display_name AND su.display_name NOT LIKE '%@%'`);
          await client.query(`CREATE TABLE IF NOT EXISTS password_reset_requests (id SERIAL PRIMARY KEY, email TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL)`);
          log("schema migrations applied", "bootstrap");
        } finally {
          client.release();
        }
      }
    }

    await registerRoutes(httpServer, app);

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
  } catch (err) {
    console.error("Fatal error during server initialization:", err);
  }
})();
