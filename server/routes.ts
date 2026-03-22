import type { Express, NextFunction, Request, Response } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertSomaUserSchema } from "@shared/schema";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { fetchPaperContext, generateAuditedQuiz, parsePdfTextFromBuffer, validateAndCorrectMcqAnswers } from "./services/aiPipeline";
import { generateWithFallback } from "./services/aiOrchestrator";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 admin requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

const analyzeClassLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 analyze-class requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.resolve(process.cwd(), "client/public/uploads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      cb(new Error("Only PNG, JPEG, WEBP, and SVG images are allowed"));
      return;
    }
    cb(null, true);
  },
});

const pdfUpload = multer({ storage: multer.memoryStorage() });

const pdfExtractionResponseSchema: any = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      question: { type: SchemaType.STRING },
      options: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
      correct_answer: { type: SchemaType.STRING },
      explanation: { type: SchemaType.STRING },
    },
    required: ["question", "options", "correct_answer", "explanation"],
  },
};

const supportingDocUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.resolve(process.cwd(), "supporting-docs");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit for supporting docs
});

const ADMIN_COOKIE_NAME = "admin_session";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
}

function getAdminUsername(): string {
  return String(process.env.ADMIN_USERNAME || "admin").toLowerCase();
}

function getAdminPasswordHash(): string {
  return String(process.env.ADMIN_PASSWORD_HASH || "");
}

function getLegacyAdminPassword(): string {
  return String(process.env.ADMIN_PASSWORD || "");
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, iterationsRaw, salt, expectedHash] = storedHash.split("$");
  if (!algorithm || !iterationsRaw || !salt || !expectedHash || algorithm !== "pbkdf2") {
    return false;
  }
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 10_000) {
    return false;
  }
  const keyLength = Buffer.from(expectedHash, "hex").length;
  const derived = crypto.pbkdf2Sync(password, salt, iterations, keyLength, "sha512");
  const expected = Buffer.from(expectedHash, "hex");
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

function parseCookies(req: Request) {
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

function getAdminSessionToken(req: Request) {
  return parseCookies(req)[ADMIN_COOKIE_NAME] || "";
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getAdminSessionToken(req);
  if (token) {
    try {
      jwt.verify(token, getJwtSecret());
      return next();
    } catch {}
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const supaToken = authHeader.slice(7);
    return verifySupabaseToken(supaToken).then((decoded) => {
      if (!decoded) return res.status(401).json({ message: "Unauthorized" });
      const userId = decoded.sub;
      return storage.getSomaUserById(userId).then((user) => {
        if (user && (user.role === "tutor" || user.role === "super_admin")) {
          (req as any).tutorId = userId;
          (req as any).tutorUser = user;
          (req as any).authUser = { id: user.id, email: user.email, role: user.role };
          return next();
        }
        return res.status(401).json({ message: "Unauthorized" });
      }).catch(() => res.status(401).json({ message: "Unauthorized" }));
    }).catch(() => res.status(401).json({ message: "Unauthorized" }));
  }
  return res.status(401).json({ message: "Unauthorized" });
}

const TUTOR_EMAIL_DOMAIN = process.env.TUTOR_EMAIL_DOMAIN || "melaniacalvin.com";

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "admin.soma@melaniacalvin.com";

function determinRole(email: string): "tutor" | "student" | "super_admin" {
  if (email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) return "super_admin";
  const domain = email.split("@")[1]?.toLowerCase();
  return domain === TUTOR_EMAIL_DOMAIN.toLowerCase() ? "tutor" : "student";
}

function requireTutor(req: Request, res: Response, next: NextFunction) {
  const tutorId = req.headers["x-tutor-id"] as string;
  if (!tutorId) {
    return res.status(401).json({ message: "Tutor ID required" });
  }
  storage.getSomaUserById(tutorId).then((user) => {
    if (!user || (user.role !== "tutor" && user.role !== "super_admin")) {
      return res.status(403).json({ message: "Access denied: tutor role required" });
    }
    (req as any).tutorId = tutorId;
    (req as any).tutorUser = user;
    next();
  }).catch(() => {
    res.status(500).json({ message: "Failed to verify tutor identity" });
  });
}

function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const adminId = req.headers["x-admin-id"] as string;
  if (!adminId) {
    return res.status(401).json({ message: "Admin ID required" });
  }
  storage.getSomaUserById(adminId).then((user) => {
    if (!user || user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied: super_admin role required" });
    }
    (req as any).adminId = adminId;
    (req as any).adminUser = user;
    next();
  }).catch(() => {
    res.status(500).json({ message: "Failed to verify admin identity" });
  });
}

/**
 * Supabase JWT authentication middleware.
 * Verifies the Bearer token from the Authorization header using the Supabase
 * JWT secret, extracts the user ID (sub claim), looks up the user in
 * soma_users, and attaches `req.authUser` with { id, email, role }.
 */
function getSupabaseJwtSecret(): string {
  return process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "";
}

async function verifySupabaseToken(token: string): Promise<{ sub: string; email?: string } | null> {
  const secret = getSupabaseJwtSecret();
  if (secret) {
    try {
      const decoded = jwt.verify(token, secret) as { sub?: string; email?: string };
      if (decoded.sub) return { sub: decoded.sub, email: decoded.email };
    } catch {}
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) return null;

  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: process.env.VITE_SUPABASE_ANON_KEY || "" },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (user?.id) return { sub: user.id, email: user.email };
  } catch {}

  return null;
}

function requireSupabaseAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const token = authHeader.slice(7);

  verifySupabaseToken(token).then((decoded) => {
    if (!decoded) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = decoded.sub;
    storage.getSomaUserById(userId).then((user) => {
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      (req as any).authUser = { id: user.id, email: user.email, role: user.role, displayName: user.displayName };
      next();
    }).catch(() => {
      res.status(500).json({ message: "Failed to verify user identity" });
    });
  }).catch(() => {
    res.status(401).json({ message: "Invalid or expired token" });
  });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many login attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const somaAiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many AI requests. Please wait before trying again.",
      details: { retryWindowMs: 60_000 },
    },
  },
});


function extractJsonArray(text: string): any[] | null {
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray((parsed as { questions?: unknown }).questions)) {
      return (parsed as { questions: any[] }).questions;
    }
    return [parsed];
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }
}

function sanitizeStudentIds(studentIds: unknown): string[] {
  if (!Array.isArray(studentIds)) return [];
  return Array.from(new Set(studentIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean)));
}

function sanitizeSubmittedAnswers(
  questions: { id: number }[],
  answers: unknown,
): Record<string, string> {
  if (!answers || typeof answers !== "object") return {};
  const rawAnswers = answers as Record<string, unknown>;
  const questionIds = new Set(questions.map((q) => String(q.id)));
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(rawAnswers)) {
    if (!questionIds.has(key) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) sanitized[key] = trimmed;
  }

  return sanitized;
}

async function runBackgroundGrading(
  reportId: number,
  questions: { id: number; stem: string; options: string[]; correctAnswer: string; marks: number }[],
  studentAnswers: Record<string, string>,
  totalScore: number,
  maxPossibleScore: number,
) {
  const GRADING_TIMEOUT_MS = 90_000;
  try {
    console.log(`[SOMA Grading] Starting background AI grading for report ${reportId}`);

    const breakdown = questions.map((q, idx) => {
      const questionNumber = idx + 1;
      const studentAnswer = studentAnswers[String(q.id)] || "(no answer)";
      const isCorrect = studentAnswer === q.correctAnswer;
      return `Question ${questionNumber}: ${q.stem}\nStudent Answer: ${studentAnswer}\nCorrect Answer: ${q.correctAnswer}\nResult: ${isCorrect ? "CORRECT" : "INCORRECT"} (${q.marks} marks)`;
    }).join("\n\n");

    const systemPrompt = `You are a mathematics tutor providing feedback to a student.

Write in simple plain English.
Be brief and direct.
Use short bullet points instead of long paragraphs.
Return clean HTML using <h3>, <ul>, <li>, <p>, and <strong>.

CRITICAL: When referencing specific questions, you MUST use the sequential question numbers provided in the data (e.g., "Question 1", "Question 4"). Never invent numbers and never use database IDs like Q156.`;

    const userPrompt = `Student scored ${totalScore}/${maxPossibleScore} (${Math.round((totalScore / maxPossibleScore) * 100)}%).

Here is the question-by-question breakdown (numbered sequentially as they appear in the quiz):

${breakdown}

Provide:
1. An overall performance summary
2. Specific strengths demonstrated
3. Areas needing improvement with concrete study suggestions — reference questions by their sequential number (e.g. "Question 3")
4. For every incorrect response, include a 1-2 sentence explanation that starts with the exact label "Question X:" and briefly explains why the correct answer is right
5. Encouragement and next steps`;

    const gradePromise = generateWithFallback(systemPrompt, userPrompt);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AI grading timed out after 90 seconds")), GRADING_TIMEOUT_MS)
    );

    const { data } = await Promise.race([gradePromise, timeoutPromise]);

    await storage.updateSomaReport(reportId, {
      status: "completed",
      aiFeedbackHtml: data,
    });

    console.log(`[SOMA Grading] Report ${reportId} graded successfully`);
  } catch (err: any) {
    console.error(`[SOMA Grading] Failed for report ${reportId}:`, err.message || err);
    try {
      await storage.updateSomaReport(reportId, {
        status: "failed",
        aiFeedbackHtml: `<p>AI analysis failed: ${err.message || "Unknown error"}. Please contact your teacher or try again later.</p>`,
      });
    } catch (dbErr: any) {
      console.error(`[SOMA Grading] Failed to update report ${reportId} to failed status:`, dbErr.message);
    }
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode >= 400 && !(body && typeof body === "object" && "error" in body)) {
        const message = typeof body?.message === "string" ? body.message : "Request failed";
        const details = body?.details ?? (body && body !== message ? body : undefined);
        return originalJson({
          error: {
            code: body?.code || `HTTP_${res.statusCode}`,
            message,
            details,
          },
        });
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  });

  app.use("/api/soma", somaAiLimiter);

  app.post("/api/auth/sync", async (req, res) => {
    try {
      const { id, email, user_metadata } = req.body;
      if (!id || !email) {
        return res.status(400).json({ message: "Missing id or email" });
      }
      const role = determinRole(email);
      console.log(`[auth-sync] email=${email} domain=${email.split("@")[1]} role=${role}`);
      const parsed = insertSomaUserSchema.parse({
        id,
        email,
        displayName: user_metadata?.display_name || user_metadata?.full_name || email.split("@")[0],
        role,
      });
      const user = await storage.upsertSomaUser(parsed);
      res.json(user);
    } catch (err: any) {
      console.error("Auth sync error:", err);
      res.status(500).json({ message: err.message || "Failed to sync user" });
    }
  });

  // Get current user's role and info
  app.get("/api/auth/me", async (req, res) => {
    try {
      const userId = req.query.userId as string;
      const email = req.query.email as string;
      if (!userId) return res.status(400).json({ message: "userId required" });
      let user = await storage.getSomaUserById(userId);
      if (!user && email) {
        const role = determinRole(email);
        console.log(`[auth-me] auto-sync for missing user: email=${email} role=${role}`);
        const parsed = insertSomaUserSchema.parse({
          id: userId,
          email,
          displayName: email.split("@")[0],
          role,
        });
        user = await storage.upsertSomaUser(parsed);
      }
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json({ id: user.id, email: user.email, displayName: user.displayName, role: user.role });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch user" });
    }
  });

  // ─── Password Reset Routes ─────────────────────────────────────────

  const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many reset requests. Please wait 15 minutes." },
  });

  app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email is required" });
      }
      const normalised = email.trim().toLowerCase();

      // Always respond with success to prevent user enumeration
      const user = await storage.getSomaUserByEmail(normalised);

      if (user) {
        // Log the reset request for auditing
        await storage.logPasswordResetRequest(normalised);

        // Use Supabase's email service to send the recovery link
        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
        if (supabaseUrl && supabaseAnonKey) {
          const { createClient } = await import("@supabase/supabase-js");
          const supabaseAdmin = createClient(supabaseUrl, supabaseAnonKey);
          const redirectTo = req.headers.origin
            ? `${req.headers.origin}/reset-password`
            : `${supabaseUrl}/reset-password`;
          await supabaseAdmin.auth.resetPasswordForEmail(normalised, { redirectTo });
        }
      }

      // Always return 200 — do not reveal whether the email exists
      res.json({ message: "If that email is registered, a reset link has been sent." });
    } catch (err: any) {
      console.error("[forgot-password]", err);
      res.status(500).json({ error: "Failed to process password reset request." });
    }
  });

  // ─── Tutor API Routes ──────────────────────────────────────────────

  // Get tutor's adopted students
  app.get("/api/tutor/students", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const students = await storage.getAdoptedStudents(tutorId);
      res.json(students);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch students" });
    }
  });

  // Get students available for adoption
  app.get("/api/tutor/students/available", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const available = await storage.getAvailableStudents(tutorId);
      res.json(available);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch available students" });
    }
  });

  // Adopt a student
  app.post("/api/tutor/students/adopt", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const { studentIds } = req.body;
      if (!Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({ message: "studentIds array required" });
      }
      const results = [];
      for (const studentId of studentIds) {
        const student = await storage.getSomaUserById(studentId);
        if (!student || student.role !== "student") continue;
        const record = await storage.adoptStudent(tutorId, studentId);
        results.push(record);
      }
      res.json({ adopted: results.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to adopt students" });
    }
  });

  // Remove adopted student
  app.delete("/api/tutor/students/:studentId", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      await storage.removeAdoptedStudent(tutorId, String(req.params.studentId));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to remove student" });
    }
  });

  // Get tutor's quizzes
  app.get("/api/tutor/quizzes", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizzes = await storage.getSomaQuizzesByAuthor(tutorId);
      res.json(quizzes.filter((q) => !q.isArchived));
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch quizzes" });
    }
  });

  // Assign quiz to students
  app.post("/api/tutor/quizzes/:quizId/assign", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(String(req.params.quizId));
      const studentIds = sanitizeStudentIds(req.body?.studentIds);
      const rawDueDate = req.body?.dueDate;
      const dueDate = rawDueDate ? new Date(rawDueDate) : null;
      if (dueDate && isNaN(dueDate.getTime())) {
        return res.status(400).json({ message: "Invalid dueDate format" });
      }
      if (studentIds.length === 0) {
        return res.status(400).json({ message: "studentIds array required" });
      }
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz || quiz.isArchived) {
        return res.status(404).json({ message: "Quiz not found" });
      }

      // Force-publish quiz on every assign — guarantees it's visible to students
      if (quiz.status !== "published") {
        await storage.updateSomaQuiz(quizId, { status: "published" });
        console.log(`[Assign] Force-published quiz ${quizId} (was "${quiz.status}")`);
      }

      const adopted = await storage.getAdoptedStudents(tutorId);
      const adoptedIds = new Set(adopted.map((s) => s.id));
      const validIds = studentIds.filter((id: string) => adoptedIds.has(id));
      if (validIds.length === 0) {
        return res.status(400).json({ message: "None of the provided students are adopted by you" });
      }
      const assignments = await storage.createQuizAssignments(quizId, validIds, dueDate);
      res.json({ assigned: assignments.length, assignments });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to assign quiz" });
    }
  });

  // Unassign a student from a quiz
  app.delete("/api/tutor/quizzes/:quizId/unassign/:studentId", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(String(req.params.quizId));
      const studentId = String(req.params.studentId);

      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      if (quiz.authorId !== tutorId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteQuizAssignment(quizId, studentId);
      return res.json({ success: true, message: "Student unassigned" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to unassign student" });
    }
  });

  // Get comprehensive details for quiz management (including student progress)
  app.get("/api/tutor/quizzes/:quizId/details", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(req.params.quizId as string);
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz || quiz.authorId !== tutorId) {
        return res.status(403).json({ message: "Access denied" });
      }

      const assignments = await storage.getQuizAssignmentsForQuiz(quizId);
      const allReports = await storage.getSomaReportsByQuizId(quizId);

      // Calculate actual max grade from question marks
      const questions = await storage.getSomaQuestionsByQuizId(quizId);
      const maxGrade = questions.reduce((sum, q) => sum + q.marks, 0) || 100;

      // Map assignments with their submission status and grades
      const studentDetails = assignments.map((assignment) => {
        const report = (allReports as any[]).find((r) => r.studentId === assignment.student.id);
        return {
          assignmentId: assignment.id,
          studentId: assignment.student.id,
          studentName: assignment.student.displayName || assignment.student.email,
          studentEmail: assignment.student.email,
          assignmentStatus: assignment.status,
          status: report ? (report.status === "completed" ? "Submitted" : report.status === "failed" ? "Failed" : "In Progress") : "Not Started",
          startTime: report?.startedAt || report?.createdAt || null,
          submissionTime: report?.completedAt || null,
          finalGrade: report?.score ?? null,
          maxGrade,
          reportId: report?.id || null,
          dueDate: assignment.dueDate || null,
        };
      });

      res.json({
        quiz,
        assignments: studentDetails,
        totalAssigned: studentDetails.length,
        totalSubmitted: studentDetails.filter((s) => s.status === "Submitted").length,
      });
    } catch (err: any) {
      console.error("Failed to fetch quiz details:", err);
      res.status(500).json({ message: err.message || "Failed to fetch quiz details" });
    }
  });

  // Revoke a student's quiz assignment
  app.delete("/api/tutor/quizzes/:quizId/assignments/:studentId", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(req.params.quizId as string);
      const studentId = req.params.studentId as string;

      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz || quiz.authorId !== tutorId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteQuizAssignment(quizId, studentId);

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to revoke assignment" });
    }
  });

  // Delete a quiz (tutor only)
  app.delete("/api/tutor/quizzes/:quizId", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(req.params.quizId as string);
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      if (quiz.authorId !== tutorId) {
        return res.status(403).json({ message: "You can only delete your own quizzes" });
      }
      await storage.deleteSomaQuiz(quizId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to delete quiz" });
    }
  });

  // Toggle archive status for a quiz
  app.patch("/api/tutor/quizzes/:quizId/archive", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(String(req.params.quizId));
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      if (quiz.authorId !== tutorId) return res.status(403).json({ message: "Access denied" });
      const updated = await storage.updateSomaQuiz(quizId, { isArchived: !quiz.isArchived });
      return res.json({ success: true, isArchived: updated?.isArchived });
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to toggle archive" });
    }
  });

  // Update due date for all assignments on a quiz
  app.patch("/api/tutor/quizzes/:quizId/due-date", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(String(req.params.quizId));
      const { dueDate } = req.body;
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      if (quiz.authorId !== tutorId) return res.status(403).json({ message: "Access denied" });
      const parsedDate = dueDate ? new Date(dueDate) : null;
      if (parsedDate && isNaN(parsedDate.getTime())) {
        return res.status(400).json({ message: "Invalid date format" });
      }
      const updated = await storage.updateQuizAssignmentsDueDate(quizId, parsedDate);
      return res.json({ success: true, updated });
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to update due date" });
    }
  });

  // Extend deadline by specified hours for all pending assignments on a quiz
  app.patch("/api/tutor/quizzes/:quizId/assignments/extend", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(String(req.params.quizId));
      const hours = Number(req.body.hours) || 24;
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      if (quiz.authorId !== tutorId) {
        return res.status(403).json({ message: "Only the author can extend deadlines" });
      }
      const updated = await storage.extendQuizAssignmentDeadlines(quizId, hours);
      return res.json({ success: true, message: `Extended deadline by ${hours}h for ${updated} assignment(s)`, updated });
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to extend deadline" });
    }
  });

  // Get assignments for a specific quiz
  app.get("/api/tutor/quizzes/:quizId/assignments", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      const assignments = await storage.getQuizAssignmentsForQuiz(quizId);
      res.json(assignments);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch assignments" });
    }
  });

  app.get("/api/tutor/quizzes/:quizId/reports", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const quizId = parseInt(String(req.params.quizId));
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      const adopted = await storage.getAdoptedStudents(tutorId);
      const adoptedIds = new Set(adopted.map((s) => s.id));
      const allReports = await storage.getSomaReportsByQuizId(quizId);
      const reports = allReports.filter((r) => r.studentId && adoptedIds.has(r.studentId));
      const questions = await storage.getSomaQuestionsByQuizId(quizId);
      const maxScore = questions.reduce((s, q) => s + q.marks, 0);
      res.json({ quiz, reports, questions, maxScore });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch reports" });
    }
  });

  app.get("/api/tutor/students/:studentId/comments", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const studentId = String(req.params.studentId);
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) return res.status(403).json({ message: "Access denied" });
      const comments = await storage.getTutorComments(tutorId, studentId);
      res.json(comments);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch comments" });
    }
  });

  app.post("/api/tutor/students/:studentId/comments", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const studentId = String(req.params.studentId);
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) return res.status(403).json({ message: "Access denied" });
      const { comment } = req.body;
      if (!comment?.trim()) return res.status(400).json({ message: "Comment is required" });
      const result = await storage.addTutorComment({ tutorId, studentId, comment: comment.trim() });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to add comment" });
    }
  });

  app.get("/api/tutor/students/:studentId/performance", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const studentId = String(req.params.studentId);
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) return res.status(403).json({ message: "Access denied" });
      const reports = await storage.getSomaReportsByStudentId(studentId);

      const reportsWithMax = await Promise.all(reports.map(async (r) => {
        const questions = await storage.getSomaQuestionsByQuizId(r.quizId);
        const maxScore = questions.reduce((s, q) => s + q.marks, 0);
        return { ...r, maxScore };
      }));

      res.json({ reports: reportsWithMax, submissions: [] });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch performance" });
    }
  });

  // Comprehensive student report: assignments joined with quizzes and reports
  app.get("/api/tutor/students/:studentId/report", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const studentId = String(req.params.studentId);
      const adopted = await storage.getAdoptedStudents(tutorId);
      if (!adopted.some((s) => s.id === studentId)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const student = await storage.getSomaUserById(studentId);
      if (!student) return res.status(404).json({ message: "Student not found" });

      // Get all assignments for this student
      const assignments = await storage.getQuizAssignmentsForStudent(studentId);

      // Get all reports for this student
      const allReports = await storage.getSomaReportsByStudentId(studentId);

      // Build detailed assignment rows
      const assignmentRows = await Promise.all(assignments.map(async (a) => {
        const quiz = a.quiz;
        const report = allReports.find((r) => r.quizId === a.quizId);
        const questions = await storage.getSomaQuestionsByQuizId(a.quizId);
        const maxScore = questions.reduce((sum, q) => sum + q.marks, 0);

        return {
          assignmentId: a.id,
          quizId: a.quizId,
          quizTitle: quiz?.title || "Untitled",
          quizSubject: quiz?.subject || null,
          quizLevel: quiz?.level || null,
          assignmentStatus: a.status,
          dueDate: a.dueDate || null,
          assignedAt: a.createdAt,
          reportId: report?.id || null,
          reportStatus: report?.status || null,
          score: report?.score ?? null,
          maxScore,
          startedAt: report?.startedAt || null,
          completedAt: report?.completedAt || null,
        };
      }));

      // Calculate aggregates
      const completedAssignments = assignmentRows.filter((a) => a.assignmentStatus === "completed");
      const gradedAssignments = assignmentRows.filter((a) => a.score !== null && a.maxScore > 0);
      const avgScore = gradedAssignments.length > 0
        ? Math.round(gradedAssignments.reduce((sum, a) => sum + ((a.score! / a.maxScore) * 100), 0) / gradedAssignments.length)
        : null;
      const totalCorrect = gradedAssignments.reduce((sum, a) => sum + (a.score || 0), 0);
      const totalPossible = gradedAssignments.reduce((sum, a) => sum + a.maxScore, 0);
      const accuracy = totalPossible > 0 ? Math.round((totalCorrect / totalPossible) * 100) : null;

      res.json({
        student: { id: student.id, email: student.email, displayName: student.displayName },
        assignments: assignmentRows,
        stats: {
          totalAssigned: assignmentRows.length,
          totalCompleted: completedAssignments.length,
          avgScore,
          accuracy,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch student report" });
    }
  });

  app.get("/api/tutor/dashboard-stats", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const stats = await storage.getDashboardStatsForTutor(tutorId);
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch stats" });
    }
  });

  // ─── Tutor Quiz Builder Routes (replaces /api/admin/* for tutors) ──

  // Session check for tutor auth
  app.get("/api/tutor/session", requireTutor, async (_req, res) => {
    res.json({ authenticated: true });
  });

  // Create a new quiz (sets authorId = tutorId)
  app.post("/api/tutor/quizzes", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const { title, syllabus, level, subject, topic, timeLimitMinutes } = req.body;
      if (!title) return res.status(400).json({ message: "title is required" });
      const quiz = await storage.createSomaQuiz({
        title,
        topic: topic || title,
        syllabus: syllabus || "IEB",
        level: level || "Grade 6-12",
        subject: subject || null,
        timeLimitMinutes: Number(timeLimitMinutes) || 60,
        authorId: tutorId,
        status: "published",
      });
      res.json(quiz);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to create quiz" });
    }
  });

  // Get a specific quiz with its questions
  app.get("/api/tutor/quizzes/:quizId/detail", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      const questions = await storage.getSomaQuestionsByQuizId(quiz.id);
      res.json({ ...quiz, questions });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch quiz" });
    }
  });

  // Update quiz metadata
  app.put("/api/tutor/quizzes/:quizId", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      const existing = await storage.getSomaQuiz(quizId);
      if (!existing) return res.status(404).json({ message: "Quiz not found" });

      const { title, syllabus, level, subject, timeLimitMinutes } = req.body;
      const updates: Record<string, string | number | null> = {};
      if (title !== undefined) updates.title = title;
      if (syllabus !== undefined) updates.syllabus = syllabus || null;
      if (level !== undefined) updates.level = level || null;
      if (subject !== undefined) updates.subject = subject || null;
      if (timeLimitMinutes !== undefined) updates.timeLimitMinutes = Number(timeLimitMinutes) || 60;

      const updated = await storage.updateSomaQuiz(quizId, updates);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to update quiz" });
    }
  });

  // Add questions to a quiz
  app.post("/api/tutor/quizzes/:quizId/questions", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const { questions } = req.body;
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ message: "questions array required" });
      }
      const rawMapped = questions.map((q: any) => ({
        stem: q.prompt_text || q.stem || "",
        options: Array.isArray(q.options) ? [...q.options] : [],
        correct_answer: String(q.correct_answer || q.correctAnswer || ""),
        explanation: String(q.explanation || ""),
        marks: Number(q.marks_worth || q.marks || 1) || 1,
      }));
      const validated = validateAndCorrectMcqAnswers(rawMapped);
      const mapped = validated.map((q) => ({
        quizId,
        stem: q.stem,
        options: q.options,
        correctAnswer: q.correct_answer,
        explanation: q.explanation,
        marks: q.marks,
      }));
      const saved = await storage.createSomaQuestions(mapped);
      res.json(saved);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to add questions" });
    }
  });

  // Delete a question
  app.delete("/api/tutor/questions/:questionId", requireTutor, async (req, res) => {
    try {
      await storage.deleteSomaQuestion(parseInt(String(req.params.questionId)));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to delete question" });
    }
  });

  // Copilot chat for tutor quiz builder
  app.post("/api/tutor/copilot-chat", requireTutor, async (req, res) => {
    try {
      const { message, documentIds } = req.body;
      if (!message) return res.status(400).json({ message: "message is required" });

      const text = String(message);
      const missing: string[] = [];
      if (!/subject\s*:/i.test(text)) missing.push("Subject");
      if (!/level\s*:/i.test(text)) missing.push("Level");
      if (!/syllabus\s*:/i.test(text)) missing.push("Syllabus");
      const hasImplicitTopic = /about\s+\w+/i.test(text);
      if (missing.length > 0 && !hasImplicitTopic) {
        return res.json({
          reply: `Before I generate, please provide: ${missing.join(", ")}.`,
          drafts: [],
          metadata: { provider: "clarification", model: "copilot-guard", durationMs: 0 },
          needsClarification: true,
        });
      }

      let supportingText = "";
      const pdfFileIds = Array.isArray(documentIds) ? documentIds : [];
      const docsDir = path.resolve(process.cwd(), "supporting-docs");
      for (const fileId of pdfFileIds) {
        if (typeof fileId !== "string" || fileId.includes("..") || fileId.includes("/")) continue;
        const filePath = path.join(docsDir, fileId);
        if (fs.existsSync(filePath)) {
          supportingText += `\n${await parsePdfTextFromBuffer(fs.readFileSync(filePath))}`;
        }
      }

      const paperCode = text.match(/\b\d{4}\/v\d\/\d{4}\b/i)?.[0];
      if (paperCode) {
        supportingText += `\n${await fetchPaperContext(paperCode)}`;
      }

      const copilotSystemPrompt = `You are SOMA Copilot, an expert MCQ assessment generator for the MCEC platform.

CRITICAL: You MUST generate questions as a JSON array with this EXACT schema:
\`\`\`json
[
  {
    "prompt_text": "The full question text with LaTeX like \\\\(x^2\\\\) if needed",
    "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
    "correct_answer": "The full text of the correct option (must exactly match one of the options)",
    "marks_worth": 2,
    "explanation": "Brief explanation of why the correct answer is right"
  }
]
\`\`\`

RULES:
- "options" MUST be an array of exactly 4 strings. NEVER use an object like {A: ..., B: ...}.
- "correct_answer" MUST be the full text of the correct option, NOT a letter like "A" or "B".
- "prompt_text" is the question text. Do NOT use "question" or "stem" as the key name.
- Every question MUST have all 5 fields: prompt_text, options, correct_answer, marks_worth, explanation.
- "explanation" MUST be 2-3 sentences that explain the underlying concept and why the correct answer is right. Make it educational and focused on learning, not just confirming correctness.
- Generate ONLY multiple-choice questions. NEVER generate open-ended, essay, or free-response questions.
- Include 1 correct answer and 3 calculated distractors based on common student errors.
- You may include a brief plain-text discussion before the JSON block.`;

      const { data, metadata } = await generateWithFallback(
        copilotSystemPrompt,
        `${text}\n\nSupporting context:\n${supportingText || "No extra context."}`,
      );

      const rawDrafts = extractJsonArray(data) || [];
      const drafts = rawDrafts.map((d: any) => {
        let opts = d.options;
        if (opts && !Array.isArray(opts) && typeof opts === "object") {
          const keys = Object.keys(opts);
          const isLetterKeyed = keys.every((k) => /^[A-Z]$/i.test(k));
          if (isLetterKeyed) {
            opts = keys.sort().map((k) => opts[k]);
          } else {
            opts = Object.values(opts);
          }
        }
        if (!Array.isArray(opts) || opts.length < 4) return null;
        opts = opts.map(String).slice(0, 4);

        const promptText = d.prompt_text || d.promptText || d.question || d.stem || "";
        if (!promptText) return null;

        let correctAnswer = String(d.correct_answer || d.correctAnswer || d.answer || "");

        // Use shared validation to correct mismatched answers
        const validated = validateAndCorrectMcqAnswers([{
          stem: String(promptText),
          options: opts,
          correct_answer: correctAnswer,
          explanation: String(d.explanation || ""),
          marks: Number(d.marks_worth || d.marksWorth || d.marks || 1) || 1,
        }]);
        correctAnswer = validated[0].correct_answer;

        return {
          prompt_text: String(promptText),
          options: opts,
          correct_answer: correctAnswer,
          marks_worth: Number(d.marks_worth || d.marksWorth || d.marks || 1) || 1,
          explanation: String(d.explanation || ""),
        };
      }).filter(Boolean);
      res.json({ reply: data, drafts, metadata, needsClarification: false });
    } catch (err: any) {
      res.status(500).json({ message: `Copilot failed: ${err.message}` });
    }
  });

  // Upload supporting document for tutor quiz builder
  app.post("/api/tutor/upload-doc", requireTutor, supportingDocUpload.single("pdf"), async (req, res) => {
    req.setTimeout(300_000);
    res.setTimeout(300_000);
    try {
      if (!req.file) return res.status(400).json({ message: "No PDF uploaded" });

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ message: "GEMINI_API_KEY is not configured" });

      const SUPPORTING_DOCS_ROOT = path.resolve(process.cwd(), "supporting-docs");
      const resolvedPath = fs.realpathSync(req.file.path);
      if (!resolvedPath.startsWith(SUPPORTING_DOCS_ROOT + path.sep)) {
        return res.status(400).json({ message: "Invalid file path" });
      }
      const pdfBuffer = fs.readFileSync(resolvedPath);
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: pdfExtractionResponseSchema,
        },
      });

      const extractionPrompt = `You are a precise document extraction tool that follows a strict Two-Pass Verification process.

=== PASS 1: CONTEXTUAL EXTRACTION ===
Read the provided document carefully and extract the exact questions found within it.\n\nRules for Pass 1:\n\n- Preserve the precise technical meaning and context of every question.\n- If the questions are already multiple-choice, extract the exact options verbatim.\n- If they are open-ended, generate 3 plausible but incorrect distractor options to format them as MCQs.\n- Format all mathematical equations, variables, and formulas strictly in KaTeX syntax.\n- Provide a concise 2-3 sentence explanation for the correct answer.

=== PASS 2: VERIFICATION & FORMATTING ===
Before finalizing your output, scan your extracted text against the original document.\n\nVerification checklist:\n\n1. Confirm that no context, qualifiers, or technical meaning was lost during extraction.\n2. Confirm that each correct_answer exactly matches one of the four options.\n3. Confirm that explanations are factually accurate and grounded in the source material.

Markdown Formatting Rules (apply to all text fields):\n\n- Use \\n\\n to separate paragraphs and distinct thoughts.\n- Use \`- \` (dash space) or \`1. \` for any lists or sequential steps within a question or explanation.\n- Do not mash sentences together. Ensure high readability.\n- Preserve line breaks where they exist in the original document.

=== STRICT JSON SCHEMA ===
Output the verified, Markdown-formatted text as a JSON array of objects with this exact schema:\n\n- question (string) \u2014 the full question text with Markdown formatting\n- options (string[] with exactly 4 options)\n- correct_answer (string that exactly matches one option)\n- explanation (string) \u2014 Markdown-formatted explanation

=== NO HALLUCINATIONS ===
You must rely ONLY on the provided PDF text. Do not generate fictitious data or simulated examples to fill in gaps. If a question is ambiguous or incomplete in the source, extract it as-is and note the ambiguity in the explanation.`;

      const result = await model.generateContent([
        { text: extractionPrompt },
        {
          inlineData: {
            mimeType: req.file.mimetype || "application/pdf",
            data: pdfBuffer.toString("base64"),
          },
        },
      ]);

      const raw = result.response.text();
      const parsed = JSON.parse(raw);
      const drafts = Array.isArray(parsed)
        ? parsed.map((item: any) => ({
            prompt_text: String(item?.question || "").trim(),
            options: Array.isArray(item?.options) ? item.options.map((opt: any) => String(opt)).slice(0, 4) : [],
            correct_answer: String(item?.correct_answer || "").trim(),
            marks_worth: 1,
            explanation: String(item?.explanation || "").trim(),
          })).filter((item: any) =>
            item.prompt_text.length > 0
            && Array.isArray(item.options)
            && item.options.length === 4
            && item.options.every((opt: string) => opt.length > 0)
            && item.correct_answer.length > 0
            && item.options.includes(item.correct_answer)
            && item.explanation.length > 0
          )
        : [];

      try { fs.unlinkSync(resolvedPath); } catch {}

      res.json({
        id: req.file.filename,
        originalName: req.file.originalname,
        drafts,
        metadata: { provider: "google", model: "gemini-2.5-flash" },
      });
    } catch (err: any) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
      res.status(500).json({ message: err.message || "Failed to extract questions from PDF" });
    }
  });

  // ─── Super Admin Routes ──────────────────────────────────────────

  app.get("/api/super-admin/users", requireSuperAdmin, async (_req, res) => {
    try {
      const users = await storage.getAllSomaUsers();
      res.json(users);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch users" });
    }
  });

  app.delete("/api/super-admin/users/:userId", requireSuperAdmin, async (req, res) => {
    try {
      const userId = String(req.params.userId);
      const user = await storage.getSomaUserById(userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (user.role === "super_admin") return res.status(403).json({ message: "Cannot delete super admin" });
      await storage.deleteSomaUser(userId);
      res.json({ message: "User deleted" });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to delete user" });
    }
  });

  app.get("/api/super-admin/quizzes", requireSuperAdmin, async (_req, res) => {
    try {
      const quizzes = await storage.getAllSomaQuizzes();
      res.json(quizzes);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch quizzes" });
    }
  });

  app.delete("/api/super-admin/quizzes/:quizId", requireSuperAdmin, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      if (isNaN(quizId)) return res.status(400).json({ message: "Invalid quiz ID" });
      await storage.deleteSomaQuiz(quizId);
      res.json({ message: "Quiz deleted" });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to delete quiz" });
    }
  });

  app.get("/api/super-admin/stats", requireSuperAdmin, async (_req, res) => {
    try {
      const [users, quizzes] = await Promise.all([
        storage.getAllSomaUsers(),
        storage.getAllSomaQuizzes(),
      ]);
      const students = users.filter((u) => u.role === "student");
      const tutors = users.filter((u) => u.role === "tutor");
      res.json({
        totalUsers: users.length,
        totalStudents: students.length,
        totalTutors: tutors.length,
        totalQuizzes: quizzes.length,
        publishedQuizzes: quizzes.filter((q) => q.status === "published").length,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch stats" });
    }
  });

  // ─── Student Routes (Supabase JWT-protected) ────────────────────

  app.get("/api/student/reports", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const reports = await storage.getSomaReportsByStudentId(studentId);

      // Bulk-compute maxScore map to avoid N+1 queries.
      const quizIds = Array.from(new Set(reports.map((r) => r.quizId)));
      const maxScoreMap = await storage.getSomaQuestionTotalsByQuizIds(quizIds);

      const enriched = reports.map((r) => ({
        ...r,
        maxScore: maxScoreMap[r.quizId] || 0,
      }));
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch reports" });
    }
  });

  app.get("/api/student/submissions", requireSupabaseAuth, async (req, res) => {
    try {
      res.json([]);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch submissions" });
    }
  });

  app.get("/api/quizzes/available", requireSupabaseAuth, async (req, res) => {
    try {
      const studentId = (req as any).authUser.id;
      const allQuizzes = await storage.getSomaQuizzes();
      const assignments = await storage.getQuizAssignmentsForStudent(studentId);

      console.log(`[Available] Fetching for Student: ${studentId}, Found Assignments: ${assignments.length}`);

      // X-ray: log every raw assignment before any filtering
      for (const a of assignments) {
        console.log(`[Available]   Assignment quizId=${a.quizId} status="${a.status}" dueDate=${a.dueDate || "null"} quizStatus="${a.quiz?.status}" quizTitle="${a.quiz?.title}"`);
      }

      const assignmentMap = new Map<number, any>();
      for (const a of assignments) {
        if (a.status === "pending") {
          assignmentMap.set(a.quizId, a);
        }
      }

      const pendingCount = assignmentMap.size;
      const publishedQuizzes = allQuizzes.filter(q => !q.isArchived && q.status === "published");

      console.log(`[Available] Student ${studentId}: ${assignments.length} total assignments, ${pendingCount} pending, ${publishedQuizzes.length} published quizzes, ${allQuizzes.length} total quizzes`);

      // Log any quiz that has a pending assignment but is NOT published (ghost assignment root cause)
      for (const quizId of Array.from(assignmentMap.keys())) {
        const matchingQuiz = allQuizzes.find(q => q.id === quizId);
        if (!matchingQuiz) {
          console.log(`[Available] WARNING: Assignment for quizId=${quizId} but quiz not found in DB!`);
        } else if (matchingQuiz.status !== "published") {
          console.log(`[Available] WARNING: Assignment for quizId=${quizId} but quiz status="${matchingQuiz.status}" (not published) — title="${matchingQuiz.title}"`);
        } else if (matchingQuiz.isArchived) {
          console.log(`[Available] WARNING: Assignment for quizId=${quizId} but quiz is archived — title="${matchingQuiz.title}"`);
        }
      }

      const available = publishedQuizzes
        .filter(q => assignmentMap.has(q.id))
        .map(q => ({
          ...q,
          isAssigned: true,
          assignmentStatus: "pending",
          dueDate: assignmentMap.get(q.id)?.dueDate || null,
        }));

      console.log(`[Available] Returning ${available.length} available quizzes for student ${studentId}`);

      return res.json(available);
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to fetch available quizzes" });
    }
  });

  app.post("/api/admin/login", loginLimiter, async (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const suppliedUsername = username || getAdminUsername();
    const suppliedPassword = password;

    const passwordHash = getAdminPasswordHash();
    const legacyPassword = getLegacyAdminPassword();
    const isValidUser = suppliedUsername === getAdminUsername();
    const isValidPassword = passwordHash
      ? verifyPassword(suppliedPassword, passwordHash)
      : Boolean(legacyPassword)
        && Buffer.byteLength(suppliedPassword) === Buffer.byteLength(legacyPassword)
        && crypto.timingSafeEqual(Buffer.from(suppliedPassword), Buffer.from(legacyPassword));

    if (!isValidUser || !isValidPassword) {
      return res.status(401).json({ message: "Invalid admin credentials." });
    }
    const token = jwt.sign({ role: "admin", username: suppliedUsername }, getJwtSecret(), { expiresIn: "12h" });
    res.cookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12,
      path: "/",
    });
    res.json({ authenticated: true });
  });

  app.get("/api/admin/session", adminRateLimiter, async (req, res) => {
    const token = getAdminSessionToken(req);
    if (token) {
      try {
        jwt.verify(token, getJwtSecret());
        return res.json({ authenticated: true });
      } catch {}
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const supaToken = authHeader.slice(7);
      try {
        const decoded = await verifySupabaseToken(supaToken);
        if (decoded?.sub) {
          const user = await storage.getSomaUserById(decoded.sub);
          if (user && (user.role === "tutor" || user.role === "super_admin")) {
            return res.json({ authenticated: true });
          }
        }
      } catch {}
    }
    res.json({ authenticated: false });
  });

  app.post("/api/analyze-class", analyzeClassLimiter, requireAdmin, async (req, res) => {
    try {
      const quizId = Number(req.body?.quizId);
      if (!Number.isInteger(quizId) || quizId <= 0) {
        return res.status(400).json({ message: "quizId is required" });
      }

      const [quiz, questions, reports] = await Promise.all([
        storage.getSomaQuiz(quizId),
        storage.getSomaQuestionsByQuizId(quizId),
        storage.getSomaReportsByQuizId(quizId),
      ]);

      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }

      const questionMeta = new Map<number, { stem: string; correctAnswer: string }>();
      for (const q of questions) {
        questionMeta.set(q.id, { stem: q.stem, correctAnswer: q.correctAnswer });
      }

      const questionStats: Record<string, {
        prompt: string;
        correct: number;
        wrong: number;
        commonMistakes: Record<string, number>;
      }> = {};

      for (const report of reports) {
        const answers = (report.answersJson || {}) as Record<string, string>;
        for (const [questionIdRaw, answerRaw] of Object.entries(answers)) {
          const questionId = Number(questionIdRaw);
          const meta = questionMeta.get(questionId);
          if (!meta) continue;

          const answer = String(answerRaw || "").trim();
          const key = String(questionId);
          if (!questionStats[key]) {
            questionStats[key] = { prompt: meta.stem, correct: 0, wrong: 0, commonMistakes: {} };
          }

          if (answer === meta.correctAnswer) {
            questionStats[key].correct += 1;
          } else {
            questionStats[key].wrong += 1;
            if (answer) {
              questionStats[key].commonMistakes[answer] = (questionStats[key].commonMistakes[answer] || 0) + 1;
            }
          }
        }
      }

      const { data, metadata } = await generateWithFallback(
        "You are a mathematics assessment analyst. Return concise HTML feedback for a teacher about class performance.",
        `Analyze class performance for quiz "${quiz.title}". Focus on misconceptions and remediation recommendations.

Summary JSON:
${JSON.stringify({
          quizId,
          quizTitle: quiz.title,
          submissionCount: reports.length,
          questionStats,
        })}`,
      );

      return res.json({ analysis: data, submissionCount: reports.length, metadata, questionStats });
    } catch (err: any) {
      return res.status(500).json({ message: err.message || "Failed to analyze class" });
    }
  });

  app.post("/api/admin/logout", async (req, res) => {
    res.clearCookie(ADMIN_COOKIE_NAME, { path: "/" });
    res.json({ success: true });
  });

  app.use("/api/admin", requireAdmin);


  app.post("/api/upload-image", requireAdmin, (req, res) => {
    upload.single("image")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ message: "Image exceeds 5MB size limit" });
        }
        return res.status(400).json({ message: err.message || "Invalid image upload" });
      }
      if (!req.file) return res.status(400).json({ message: "No image uploaded" });
      const url = `/uploads/${req.file.filename}`;
      res.json({ url });
    });
  });

  const somaGenerateSchema = z.object({
    topic: z.string().min(1, "topic is required"),
    title: z.string().optional(),
    subject: z.string().min(1).default("Mathematics"),
    syllabus: z.string().min(1).default("IEB"),
    level: z.string().min(1).default("Grade 6-12"),
    curriculumContext: z.string().optional(),
  });

  app.post("/api/soma/generate", requireAdmin, async (req, res) => {
    try {
      const parsed = somaGenerateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { topic, title, curriculumContext, subject, syllabus, level } = parsed.data;
      const quizTitle = title || `${topic} Quiz`;

      const result = await generateAuditedQuiz({
        topic,
        subject,
        syllabus,
        level,
        copilotPrompt: curriculumContext,
      });

      const quiz = await storage.createSomaQuiz({
        title: quizTitle,
        topic,
        subject,
        syllabus,
        level,
        curriculumContext: curriculumContext || null,
        status: "published",
        isArchived: false,
      });

      const insertedQuestions = await storage.createSomaQuestions(
        result.questions.map((q) => ({
          quizId: quiz.id,
          stem: q.stem,
          options: q.options,
          correctAnswer: q.correct_answer,
          explanation: q.explanation,
          marks: q.marks,
        }))
      );

      res.json({
        quiz,
        questions: insertedQuestions,
        pipeline: {
          stages: ["Claude Sonnet (Maker)", "Gemini 2.5 Flash (Checker)"],
          totalQuestions: insertedQuestions.length,
        },
      });
    } catch (err: any) {
      console.error("[SOMA] Generation failed:", err);
      res.status(500).json({ message: `Pipeline failed: ${err.message}` });
    }
  });

  // Tutor quiz generation — sets authorId and optionally assigns to students
  app.post("/api/tutor/quizzes/generate", requireTutor, async (req, res) => {
    try {
      const tutorId = (req as any).tutorId;
      const parsed = somaGenerateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { topic, title, curriculumContext, subject, syllabus, level } = parsed.data;
      const requestedStudentIds = sanitizeStudentIds(req.body?.assignTo);
      const quizTitle = title || `${topic} Quiz`;

      const result = await generateAuditedQuiz({
        topic, subject, syllabus, level,
        copilotPrompt: curriculumContext,
      });

      const adopted = await storage.getAdoptedStudents(tutorId);
      const adoptedIds = new Set(adopted.map((s) => s.id));
      const validAssignedStudentIds = requestedStudentIds.filter((id) => adoptedIds.has(id));

      const bundle = await storage.createSomaQuizBundle({
        quiz: {
          title: quizTitle,
          topic,
          subject,
          syllabus,
          level,
          curriculumContext: curriculumContext || null,
          authorId: tutorId,
          status: "published",
          isArchived: false,
        },
        questions: result.questions.map((q) => ({
          stem: q.stem,
          options: q.options,
          correctAnswer: q.correct_answer,
          explanation: q.explanation,
          marks: q.marks,
        })),
        assignedStudentIds: validAssignedStudentIds,
      });

      res.json({
        quiz: bundle.quiz,
        questions: bundle.questions,
        assignments: bundle.assignments.length,
        assignedStudentIds: validAssignedStudentIds,
        pipeline: {
          stages: ["Claude Sonnet (Maker)", "Gemini 2.5 Flash (Checker)"],
          totalQuestions: bundle.questions.length,
        },
      });
    } catch (err: any) {
      console.error("[SOMA Tutor] Generation failed:", err);
      res.status(500).json({ message: `Pipeline failed: ${err.message}` });
    }
  });

  app.get("/api/soma/quizzes", async (_req, res) => {
    try {
      const allQuizzes = await storage.getSomaQuizzes();
      res.json(allQuizzes.filter((q) => !q.isArchived));
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/soma/quizzes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid quiz ID" });

      const quiz = await storage.getSomaQuiz(id);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      res.json(quiz);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/soma/quizzes/:id/questions", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid quiz ID" });

      const allQuestions = await storage.getSomaQuestionsByQuizId(id);
      const sanitized = allQuestions.map(({ correctAnswer, explanation, ...rest }) => rest);
      res.json(sanitized);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/soma/quizzes/:id/submit", async (req, res) => {
    try {
      const quizId = parseInt(req.params.id);
      if (isNaN(quizId)) return res.status(400).json({ message: "Invalid quiz ID" });

      const { studentId, studentName, answers, startedAt } = req.body;
      if (!studentId || !answers) {
        return res.status(400).json({ message: "Missing studentId or answers" });
      }

      const dbUser = await storage.getSomaUserById(studentId);
      const resolvedName = dbUser?.displayName || studentName || "Student";

      const alreadySubmitted = await storage.checkSomaSubmission(quizId, studentId);
      if (alreadySubmitted) {
        return res.status(409).json({ message: "You have already submitted this quiz." });
      }

      const allQuestions = await storage.getSomaQuestionsByQuizId(quizId);
      if (!allQuestions.length) {
        return res.status(404).json({ message: "No questions found for this quiz." });
      }

      const sanitizedAnswers = sanitizeSubmittedAnswers(allQuestions, answers);

      let totalScore = 0;
      for (const q of allQuestions) {
        if (sanitizedAnswers[String(q.id)] === q.correctAnswer) {
          totalScore += q.marks;
        }
      }

      const now = new Date();
      const parsedStartedAt = startedAt ? new Date(startedAt) : null;

      const report = await storage.createSomaReport({
        quizId,
        studentId,
        studentName: resolvedName,
        score: totalScore,
        status: "pending",
        answersJson: sanitizedAnswers,
        startedAt: parsedStartedAt && !isNaN(parsedStartedAt.getTime()) ? parsedStartedAt : null,
        completedAt: now,
      });

      res.json(report);

      // Mark quiz assignment as completed
      storage.updateQuizAssignmentStatus(quizId, studentId, "completed").catch(() => {});

      const maxPossibleScore = allQuestions.reduce((s, q) => s + q.marks, 0);
      runBackgroundGrading(report.id, allQuestions, answers, totalScore, maxPossibleScore).catch(() => {});
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/soma/quizzes/:id/check-submission", async (req, res) => {
    try {
      const quizId = parseInt(req.params.id);
      const studentId = req.query.studentId as string;
      if (isNaN(quizId) || !studentId) {
        return res.status(400).json({ message: "quizId and studentId required" });
      }
      const exists = await storage.checkSomaSubmission(quizId, studentId);
      res.json({ submitted: exists });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/soma/reports/:reportId/review", requireSupabaseAuth, async (req, res) => {
    try {
      const reportId = parseInt(String(req.params.reportId));
      if (isNaN(reportId)) return res.status(400).json({ message: "Invalid report ID" });

      const report = await storage.getSomaReportById(reportId);
      if (!report) return res.status(404).json({ message: "Report not found" });

      // Ownership check: student owns the report, OR tutor adopted the student, OR super_admin
      const authUser = (req as any).authUser as { id: string; role: string };
      const isOwner = report.studentId === authUser.id;
      const isSuperAdmin = authUser.role === "super_admin";

      if (!isOwner && !isSuperAdmin) {
        // Check if requester is a tutor who adopted this student
        if (authUser.role === "tutor" && report.studentId) {
          const adopted = await storage.getAdoptedStudents(authUser.id);
          const isTutorOfStudent = adopted.some((s) => s.id === report.studentId);
          if (!isTutorOfStudent) {
            return res.status(403).json({ message: "Forbidden: you do not have access to this report" });
          }
        } else {
          return res.status(403).json({ message: "Forbidden: you do not have access to this report" });
        }
      }

      const questions = await storage.getSomaQuestionsByQuizId(report.quizId);

      res.json({
        report,
        questions: questions.map((q) => ({
          id: q.id,
          stem: q.stem,
          options: q.options,
          correctAnswer: q.correctAnswer,
          marks: q.marks,
          explanation: q.explanation,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/soma/reports/:reportId/retry", async (req, res) => {
    try {
      const reportId = parseInt(req.params.reportId);
      if (isNaN(reportId)) return res.status(400).json({ message: "Invalid report ID" });

      const report = await storage.getSomaReportById(reportId);
      if (!report) return res.status(404).json({ message: "Report not found" });

      if (report.status !== "failed") {
        return res.status(400).json({ message: "Only failed reports can be retried" });
      }

      await storage.updateSomaReport(reportId, { status: "pending", aiFeedbackHtml: null });

      const questions = await storage.getSomaQuestionsByQuizId(report.quizId);
      const answers = (report.answersJson as Record<string, string>) || {};
      const maxPossibleScore = questions.reduce((s, q) => s + q.marks, 0);

      res.json({ message: "Retry started", reportId });

      runBackgroundGrading(reportId, questions, answers, report.score, maxPossibleScore).catch(() => {});
    } catch (err: any) {
      console.error("[Retry Grading] Error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/soma/global-tutor", async (req, res) => {
    try {
      const { message, studentId } = req.body;
      if (!message) return res.status(400).json({ message: "Message is required" });

      let completedContext = "";
      let untestedContext = "";
      let hasStudentData = false;

      if (studentId) {
        const [reports, allSomaQuizzes] = await Promise.all([
          storage.getSomaReportsByStudentId(studentId),
          storage.getSomaQuizzes(),
        ]);

        const completedReports = reports.filter(
          (r) => r.status === "completed" && r.aiFeedbackHtml
        );

        if (completedReports.length > 0) {
          hasStudentData = true;
          const feedbackEntries = await Promise.all(completedReports.map(async (r, i) => {
            const questions = await storage.getSomaQuestionsByQuizId(r.quizId);
            const maxScore = questions.reduce((s, q) => s + q.marks, 0);
            const pct = maxScore > 0 ? Math.round((r.score / maxScore) * 100) : 0;
            const scoreInfo = r.score !== null ? `Score: ${r.score}/${maxScore} (${pct}%)` : "Score: N/A";
            return `--- Quiz ${i + 1}: "${r.quiz.title}" | Topic: ${r.quiz.topic || "General"} | ${scoreInfo} ---\n${r.aiFeedbackHtml}`;
          }));
          completedContext = feedbackEntries.join("\n\n");
        }

        const completedQuizIds = new Set(reports.map((r) => r.quizId));
        const untestedQuizzes = allSomaQuizzes
          .filter((q) => q.status === "published" && !completedQuizIds.has(q.id));

        if (untestedQuizzes.length > 0) {
          hasStudentData = true;
          untestedContext = untestedQuizzes.map((q) => {
            return `- "${q.title}" | Topic: ${q.topic || "General"} | Curriculum: ${q.curriculumContext || "N/A"}`;
          }).join("\n");
        }
      }

      const systemPrompt = hasStudentData
        ? `You are an elite academic advisor. You are provided with a student's past quiz feedback, AND a list of upcoming syllabus topics they have not yet been tested on. You must output a 3-part HTML report:

1. **Overall Standing**: A brutal but fair assessment of their current grades.

2. **Weak Fundamentals**: What they keep getting wrong based on past feedback.

3. **Untested Territory (CRITICAL)**: Look at the 'Untested Quizzes' array provided. Explicitly list the topics they have not taken yet, and advise them on how to prepare for those specific upcoming subjects.

Also answer any specific question the student asks, informed by their performance history and untested topics. Use <h3> for section headings, <ul>/<li> for lists, <p> for paragraphs, and <strong> for emphasis. Format output as clean HTML.`
        : "You are a helpful and encouraging math tutor. Answer the student's question clearly and thoroughly. Use LaTeX notation where appropriate (wrap inline math in $...$ and display math in $$...$$).";

      let userPrompt = message;
      if (hasStudentData) {
        const dataSections: string[] = [];
        if (completedContext) {
          dataSections.push(`=== COMPLETED QUIZ FEEDBACK (${completedContext.split("--- Quiz").length - 1} quizzes) ===\n${completedContext}\n=== END COMPLETED ===`);
        }
        if (untestedContext) {
          dataSections.push(`=== UNTESTED QUIZZES (topics not yet attempted) ===\n${untestedContext}\n=== END UNTESTED ===`);
        }
        userPrompt = `${dataSections.join("\n\n")}\n\nStudent's Question: ${message}`;
      }

      const result = await generateWithFallback(systemPrompt, userPrompt);
      res.json({ reply: result.data });
    } catch (err: any) {
      console.error("[Global Tutor] Error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  return httpServer;
}
