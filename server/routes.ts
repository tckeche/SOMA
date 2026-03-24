import type { Express, NextFunction, Request, Response } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { insertSomaUserSchema, graphQuestionSpecSchema } from "@shared/schema";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import { createRoleMiddleware, getAdminSessionToken, getAuthorizedUserFromBearer, verifySupabaseToken } from "./auth";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { fetchPaperContext, generateAuditedQuiz, parsePdfTextFromBuffer, validateAndCorrectMcqAnswers } from "./services/aiPipeline";
import { balanceAnswerOptions, buildCopilotSummary, buildSyllabusChunks, copilotResponseSchema, scoreSyllabusChunks } from "./services/assessmentGeneration";
import { generateWithFallback } from "./services/aiOrchestrator";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { GraphQuestionSpec } from "@shared/schema";

/**
 * Attempt to repair a raw graph_spec from AI output into a valid GraphQuestionSpec.
 * Returns the parsed spec on success, or null if it cannot be repaired.
 */
function repairGraphSpec(raw: unknown): import("@shared/schema").GraphQuestionSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Normalise xRange / yRange — AI sometimes returns {min,max} objects instead of tuples
  const normaliseRange = (v: unknown): [number, number] | null => {
    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
      return [v[0], v[1]];
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      // {min,max} or {0,1} or first two numeric values
      const nums = [obj.min ?? obj[0] ?? obj.from, obj.max ?? obj[1] ?? obj.to]
        .map(Number)
        .filter((n) => Number.isFinite(n));
      if (nums.length === 2) return [nums[0], nums[1]];
      const allNums = keys.map((k) => Number(obj[k])).filter((n) => Number.isFinite(n));
      if (allNums.length >= 2) return [allNums[0], allNums[1]];
    }
    return null;
  };

  const xRange = normaliseRange(r.xRange);
  const yRange = normaliseRange(r.yRange);
  if (!xRange || !yRange) return null;

  // plotType — default to "line" for equation-based, "points" if only points
  const rawPlotType = String(r.plotType || "");
  const validPlotTypes = ["line", "curve", "scatter", "points"] as const;
  const plotType: "line" | "curve" | "scatter" | "points" = validPlotTypes.includes(rawPlotType as never)
    ? (rawPlotType as "line" | "curve" | "scatter" | "points")
    : r.equation || r.curves
    ? "line"
    : "points";

  // Multi-curve support: parse the `curves` array if present
  const curves = Array.isArray(r.curves)
    ? (r.curves as any[])
        .filter((c: any) => c && typeof c === "object" && typeof c.equation === "string" && c.equation.trim())
        .map((c: any) => ({
          equation: String(c.equation),
          label: c.label ? String(c.label) : undefined,
          color: c.color ? String(c.color) : undefined,
        }))
    : undefined;

  // Require at least equation, curves, or points
  const equation = r.equation && typeof r.equation === "string" ? r.equation : undefined;
  const points = Array.isArray(r.points) ? r.points : undefined;
  if (!equation && (!curves || curves.length === 0) && (!points || points.length === 0)) return null;

  // axisLabels — default to x/y if missing
  const rawLabels = r.axisLabels && typeof r.axisLabels === "object" ? (r.axisLabels as Record<string, unknown>) : {};
  const axisLabels = {
    x: String(rawLabels.x || "x"),
    y: String(rawLabels.y || "y"),
  };

  const tickInterval = typeof r.tickInterval === "number" && r.tickInterval > 0 ? r.tickInterval : 1;
  const showGrid = r.showGrid !== false;
  const highlightedPoints = Array.isArray(r.highlightedPoints) ? r.highlightedPoints : undefined;

  const repaired = {
    plotType,
    equation,
    curves: curves && curves.length > 0 ? curves : undefined,
    points: points as { x: number; y: number; label?: string }[] | undefined,
    xRange,
    yRange,
    axisLabels,
    showGrid,
    tickInterval,
    highlightedPoints: highlightedPoints as { x: number; y: number; label?: string }[] | undefined,
  };

  const parsed = graphQuestionSpecSchema.safeParse(repaired);
  return parsed.success ? parsed.data : null;
}

const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 admin requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

// ---------------------------------------------------------------------------
// Draft Assessment Store — in-memory, keyed by quizId
// Drafts survive page refresh for the current server process.
// ---------------------------------------------------------------------------
export interface DraftQuestion {
  draftId: string;
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  marks: number;
  questionType: "multiple_choice" | "graph";
  graphSpec?: import("@shared/schema").GraphQuestionSpec | null;
  topicTag?: string | null;
  subtopicTag?: string | null;
  difficultyTag?: string | null;
}

const draftStore = new Map<number, { questions: DraftQuestion[]; updatedAt: Date }>();

function getDraft(quizId: number): DraftQuestion[] {
  return draftStore.get(quizId)?.questions ?? [];
}

function setDraft(quizId: number, questions: DraftQuestion[]): void {
  draftStore.set(quizId, { questions, updatedAt: new Date() });
}

// ---------------------------------------------------------------------------
// Server-side mirror of the client's applyDraftAction (kept in sync)
// ---------------------------------------------------------------------------
function applyDraftActionServer(
  current: DraftQuestion[],
  action: CopilotActionType,
  questions: DraftQuestion[],
  positions: number[],
): DraftQuestion[] {
  switch (action) {
    case "ADD": return [...current, ...questions];
    case "REPLACE_ALL": return [...questions];
    case "REPLACE_SELECTED": {
      const next = [...current];
      positions.forEach((pos, i) => {
        const idx = pos - 1;
        if (idx >= 0 && idx < next.length && questions[i]) next[idx] = questions[i];
      });
      return next;
    }
    case "DELETE": {
      const toRemove = new Set(positions.map((p) => p - 1));
      return current.filter((_, i) => !toRemove.has(i));
    }
    case "REORDER": {
      if (positions.length !== current.length) return current;
      return positions.map((pos) => current[pos - 1]).filter(Boolean);
    }
    default: return current;
  }
}

// Detect whether the user's message is requesting graph questions
function isGraphRequestMessage(text: string): boolean {
  return /\bgraph\b|\bplot\b|\bvisual(?:ise|ize|ised|ized)?\b|\bplotted?\b/i.test(text);
}

// The explicit graph spec system prompt used for targeted graph retries
const GRAPH_RETRY_SYSTEM_PROMPT = `You are a graph question generator for any subject (Maths, Physics, Economics, Biology, Chemistry, etc.). Your ONLY job is to return a JSON object with exactly the format below.

Return ONLY this JSON structure, with no extra text:
{
  "questions": [
    {
      "prompt_text": "<question text>",
      "options": ["<opt1>", "<opt2>", "<opt3>", "<opt4>"],
      "correct_answer": "<one of the 4 options, copied exactly>",
      "marks_worth": 2,
      "explanation": "<non-empty explanation>",
      "topic_tag": "<topic>",
      "subtopic_tag": "<subtopic>",
      "difficulty_tag": "medium",
      "question_type": "graph",
      "graph_spec": {
        "plotType": "line",
        "equation": "2*x + 1",
        "xRange": [-5, 5],
        "yRange": [-10, 10],
        "axisLabels": {"x": "x", "y": "y"},
        "showGrid": true,
        "tickInterval": 1
      }
    }
  ]
}

For MULTI-CURVE graphs (e.g. Supply & Demand, comparing two functions), use "curves" instead of "equation":
  "graph_spec": {
    "plotType": "line",
    "curves": [
      {"equation": "2*x + 1", "label": "Supply", "color": "#34d399"},
      {"equation": "-x + 8",  "label": "Demand", "color": "#f87171"}
    ],
    "xRange": [0, 6], "yRange": [0, 10],
    "axisLabels": {"x": "Quantity", "y": "Price"},
    "showGrid": true, "tickInterval": 1
  }

Subject-specific axis examples:
- Physics velocity-time:  axisLabels {"x":"t (s)","y":"v (m/s)"}  equation e.g. "3*x + 2"
- Physics force-extension: axisLabels {"x":"Extension (m)","y":"Force (N)"}
- Economics supply/demand: axisLabels {"x":"Quantity","y":"Price"}, use curves array
- Biology enzyme: axisLabels {"x":"Temperature (°C)","y":"Rate of reaction"}
- Chemistry concentration: axisLabels {"x":"Time (s)","y":"Concentration (mol/L)"}

CRITICAL FORMAT RULES (breaking any of these means your output is INVALID):
1. xRange and yRange MUST be JSON arrays like [-5, 5] — NEVER objects like {"min":-5, "max":5}
2. You MUST include "equation" (single curve) OR "curves" (array) OR "points" — never omit all three
3. equation/curves[i].equation MUST use * for multiplication: write "2*x + 1" NOT "2x + 1"
4. graph_spec is REQUIRED for every question — never omit it
5. Every question MUST have exactly 4 distinct options
6. correct_answer MUST be an exact copy of one of the 4 options
7. question_type MUST be "graph"
8. When using "curves", each entry needs at least "equation" and "label"
9. equations use variable x only (the renderer evaluates f(x))`;

/** Normalise a raw copilot draft object into a DraftQuestion */
function normaliseToDraftQuestion(raw: any): DraftQuestion | null {
  let opts = raw.options;
  if (opts && !Array.isArray(opts) && typeof opts === "object") {
    const keys = Object.keys(opts);
    opts = keys.every((k) => /^[A-Z]$/i.test(k))
      ? keys.sort().map((k) => opts[k])
      : Object.values(opts);
  }
  if (!Array.isArray(opts) || opts.length < 4) return null;
  opts = opts.map(String).slice(0, 4);

  const stem = String(raw.prompt_text || raw.promptText || raw.question || raw.stem || "");
  if (!stem) return null;

  const explanation = String(raw.explanation || "");
  const marks = Number(raw.marks_worth || raw.marksWorth || raw.marks || 1) || 1;

  let correctAnswer = String(raw.correct_answer || raw.correctAnswer || raw.answer || "");
  if (!opts.includes(correctAnswer)) correctAnswer = opts[0];

  let questionType: "multiple_choice" | "graph" = raw.question_type === "graph" ? "graph" : "multiple_choice";
  let graphSpec: import("@shared/schema").GraphQuestionSpec | null = null;
  if (raw.graph_spec) {
    const repaired = repairGraphSpec(raw.graph_spec);
    if (repaired) { graphSpec = repaired; questionType = "graph"; }
    else { questionType = "multiple_choice"; }
  }

  return {
    draftId: `draft-${crypto.randomUUID()}`,
    stem,
    options: opts,
    correctAnswer,
    explanation,
    marks,
    questionType,
    graphSpec,
    topicTag: raw.topic_tag ? String(raw.topic_tag) : null,
    subtopicTag: raw.subtopic_tag ? String(raw.subtopic_tag) : null,
    difficultyTag: raw.difficulty_tag ? String(raw.difficulty_tag) : null,
  };
}

const analyzeClassLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 analyze-class requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

const authApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const tutorApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const superAdminApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
});

const studentApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadImageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
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

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = getAdminSessionToken(req, ADMIN_COOKIE_NAME);
  if (token) {
    try {
      jwt.verify(token, getJwtSecret());
      return next();
    } catch {}
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const supaToken = authHeader.slice(7);
    return getAuthorizedUserFromBearer(supaToken, ["tutor", "super_admin"])
      .then((user) => {
        if (!user) return res.status(401).json({ message: "Unauthorized" });
        (req as any).tutorId = user.id;
        (req as any).tutorUser = user;
        (req as any).authUser = { id: user.id, email: user.email, role: user.role, displayName: user.displayName };
        return next();
      })
      .catch(() => res.status(401).json({ message: "Unauthorized" }));
  }

  return res.status(401).json({ message: "Unauthorized" });
}

const TUTOR_EMAIL_DOMAIN = process.env.TUTOR_EMAIL_DOMAIN || "melaniacalvin.com";

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "admin.soma@melaniacalvin.com";

function determineRole(email: string): "tutor" | "student" | "super_admin" {
  if (email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) return "super_admin";
  const domain = email.split("@")[1]?.toLowerCase();
  return domain === TUTOR_EMAIL_DOMAIN.toLowerCase() ? "tutor" : "student";
}

const requireTutor = createRoleMiddleware({
  allowedRoles: ["tutor", "super_admin"],
  identityHeaderName: "x-tutor-id",
  missingIdentityMessage: "Tutor ID required",
  forbiddenMessage: "Access denied: tutor role required",
  requestIdKey: "tutorId",
  requestUserKey: "tutorUser",
});

const requireSuperAdmin = createRoleMiddleware({
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
    // Support objects with a known question-list key
    for (const key of ["drafts", "questions", "items"]) {
      if (parsed && Array.isArray((parsed as Record<string, unknown>)[key])) {
        return (parsed as Record<string, any[]>)[key];
      }
    }
    return null;
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


type CopilotActionType = "ADD" | "REPLACE_ALL" | "REPLACE_SELECTED" | "DELETE" | "REORDER" | "NONE";

interface ParsedCopilotResponse {
  reply: string;
  action: CopilotActionType;
  questions: any[];       // new/replacement question objects
  positions: number[];    // 1-based position numbers (for REPLACE_SELECTED, DELETE, REORDER)
}

function extractStructuredCopilotResponse(text: string): ParsedCopilotResponse {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const EMPTY: ParsedCopilotResponse = { reply: "Assessment draft prepared.", action: "NONE", questions: [], positions: [] };

  try {
    const parsed = JSON.parse(cleaned);

    const reply: string =
      typeof parsed.reply === "string" && parsed.reply.trim()
        ? parsed.reply.trim()
        : "Assessment draft prepared.";

    // Determine action type
    const rawAction = typeof parsed.action === "string" ? parsed.action.toUpperCase().trim() : "";
    const VALID_ACTIONS: CopilotActionType[] = ["ADD", "REPLACE_ALL", "REPLACE_SELECTED", "DELETE", "REORDER", "NONE"];
    const action: CopilotActionType = VALID_ACTIONS.includes(rawAction as CopilotActionType)
      ? (rawAction as CopilotActionType)
      : "ADD";

    // Raw questions array — accept drafts or questions key for compatibility
    const questions: any[] = Array.isArray(parsed.questions)
      ? parsed.questions
      : Array.isArray(parsed.drafts)
        ? parsed.drafts
        : [];

    // Positions array (1-based)
    const positions: number[] = Array.isArray(parsed.positions)
      ? parsed.positions.map(Number).filter((n) => Number.isInteger(n) && n >= 1)
      : [];

    return { reply, action, questions, positions };
  } catch {
    const questions = extractJsonArray(cleaned) || [];
    return { ...EMPTY, action: questions.length > 0 ? "ADD" : "NONE", questions };
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

  app.use("/api/admin", adminRateLimiter);
  app.use("/api/auth", authApiLimiter);
  app.use("/api/tutor", tutorApiLimiter);
  app.use("/api/super-admin", superAdminApiLimiter);
  app.use("/api/student", studentApiLimiter);
  app.use("/api/quizzes", studentApiLimiter);
  app.use("/api/soma", somaAiLimiter);

  app.post("/api/auth/sync", async (req, res) => {
    try {
      const { id, email, user_metadata } = req.body;
      if (!id || !email) {
        return res.status(400).json({ message: "Missing id or email" });
      }
      const role = determineRole(email);
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
        const role = determineRole(email);
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

      // Log the request for auditing only if the user exists.
      // The browser sends the Supabase email directly (preserving the PKCE
      // code-verifier in localStorage so the reset link works).
      const user = await storage.getSomaUserByEmail(normalised);
      if (user) {
        await storage.logPasswordResetRequest(normalised);
      }

      // Always return 200 — never reveal whether the email exists.
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
      if (!timeLimitMinutes || isNaN(Number(timeLimitMinutes))) {
        return res.status(400).json({ message: "timeLimitMinutes is required and must be a number" });
      }
      const quiz = await storage.createSomaQuiz({
        title,
        topic: topic || title,
        syllabus: syllabus ?? null,
        level: level ?? null,
        subject: subject ?? null,
        timeLimitMinutes: Number(timeLimitMinutes),
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

  // ── Draft endpoints ────────────────────────────────────────────────────────

  // GET current draft for a quiz (returns [] if no draft exists)
  app.get("/api/tutor/quizzes/:quizId/draft", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      if (!quizId) return res.status(400).json({ message: "Invalid quizId" });
      const questions = getDraft(quizId);
      res.json({ quizId, questions });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch draft" });
    }
  });

  // PUT replace entire draft (client sends full DraftQuestion[])
  app.put("/api/tutor/quizzes/:quizId/draft", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      if (!quizId) return res.status(400).json({ message: "Invalid quizId" });
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });
      const { questions } = req.body;
      if (!Array.isArray(questions)) return res.status(400).json({ message: "questions array required" });
      setDraft(quizId, questions as DraftQuestion[]);
      res.json({ quizId, questions, updatedAt: new Date() });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to save draft" });
    }
  });

  // POST publish draft → write to soma_questions (replaces all existing questions)
  app.post("/api/tutor/quizzes/:quizId/publish", requireTutor, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.quizId));
      const quiz = await storage.getSomaQuiz(quizId);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

      const draft = getDraft(quizId);
      if (draft.length === 0) return res.status(400).json({ message: "Draft is empty — add questions before publishing" });

      // Validate each draft question before write
      for (const q of draft) {
        if (!q.stem || !Array.isArray(q.options) || q.options.length !== 4) {
          return res.status(400).json({ message: `Question "${String(q.stem || "").slice(0, 40)}" is missing required fields` });
        }
        if (q.questionType === "graph" && q.graphSpec) {
          const check = repairGraphSpec(q.graphSpec);
          if (!check) return res.status(400).json({ message: "A graph question has an invalid graph spec" });
        }
      }

      // Delete all existing questions for this quiz
      await storage.deleteSomaQuestionsByQuizId(quizId);

      // Insert draft questions
      const mapped = draft.map((q) => ({
        quizId,
        stem: q.stem,
        options: q.options,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        marks: q.marks,
        questionType: q.questionType,
        graphSpec: (q.graphSpec ?? null) as import("@shared/schema").GraphQuestionSpec | null,
        topicTag: q.topicTag ?? null,
        subtopicTag: q.subtopicTag ?? null,
        difficultyTag: q.difficultyTag ?? null,
      }));

      const saved = await storage.createSomaQuestions(mapped);

      // Clear draft after successful publish
      draftStore.delete(quizId);

      res.json({ quizId, publishedCount: saved.length, questions: saved });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to publish" });
    }
  });

  // ── End draft endpoints ────────────────────────────────────────────────────

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
      for (const q of questions) {
        if (!q.prompt_text && !q.stem) {
          return res.status(400).json({ message: "Each question must have a prompt_text" });
        }
        if (!Array.isArray(q.options) || q.options.length !== 4) {
          return res.status(400).json({ message: "Each question must have exactly 4 options" });
        }
      }
      const rawMapped = questions.map((q: any) => {
        // Validate and repair graph_spec — reject broken specs, downgrade type if needed
        let questionType = String(q.question_type || (q.graph_spec ? "graph" : "multiple_choice"));
        let graphSpec: GraphQuestionSpec | null = null;
        if (q.graph_spec) {
          const repaired = repairGraphSpec(q.graph_spec);
          if (repaired) {
            graphSpec = repaired;
            questionType = "graph";
          } else {
            // Cannot repair — downgrade to MCQ so it still saves as a usable question
            questionType = "multiple_choice";
          }
        }
        return {
          stem: q.prompt_text || q.stem || "",
          options: Array.isArray(q.options) ? [...q.options] : [],
          correct_answer: String(q.correct_answer || q.correctAnswer || ""),
          explanation: String(q.explanation || ""),
          marks: Number(q.marks_worth || q.marks || 1) || 1,
          question_type: questionType,
          graph_spec: graphSpec,
          topic_tag: q.topic_tag ? String(q.topic_tag) : null,
          subtopic_tag: q.subtopic_tag ? String(q.subtopic_tag) : null,
          difficulty_tag: q.difficulty_tag ? String(q.difficulty_tag) : null,
        };
      });
      const balanced = balanceAnswerOptions(rawMapped);
      const validated = validateAndCorrectMcqAnswers(balanced);
      const mapped = validated.map((q, index) => ({
        quizId,
        stem: q.stem,
        options: q.options,
        correctAnswer: q.correct_answer,
        explanation: q.explanation,
        marks: q.marks,
        questionType: rawMapped[index].question_type || "multiple_choice",
        graphSpec: rawMapped[index].graph_spec,
        topicTag: rawMapped[index].topic_tag,
        subtopicTag: rawMapped[index].subtopic_tag,
        difficultyTag: rawMapped[index].difficulty_tag,
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

  app.get("/api/tutor/syllabus-documents", requireTutor, async (req, res) => {
    try {
      const documents = await storage.listSyllabusDocuments((req as any).tutorId);
      res.json(documents.map((document) => ({
        id: document.id,
        board: document.board,
        level: document.level,
        syllabusCode: document.syllabusCode,
        filename: document.filename,
        uploadedAt: document.uploadedAt,
      })));
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch syllabus documents" });
    }
  });

  app.post("/api/tutor/syllabus-documents", requireTutor, pdfUpload.single("pdf"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No PDF uploaded" });
      const { board, level, syllabusCode } = req.body;
      if (!board || !level || !syllabusCode) {
        return res.status(400).json({ message: "board, level, and syllabusCode are required" });
      }

      const extractedText = await parsePdfTextFromBuffer(req.file.buffer);
      if (extractedText.split(/\s+/).filter(Boolean).length < 50) {
        return res.status(400).json({ message: "This PDF appears to be image-only or unreadable as text. Please upload a text-based syllabus PDF." });
      }

      const chunks = buildSyllabusChunks(extractedText);
      const created = await storage.createSyllabusDocument({
        tutorId: (req as any).tutorId ?? null,
        board: String(board).trim(),
        level: String(level).trim(),
        syllabusCode: String(syllabusCode).trim(),
        filename: req.file.originalname,
        extractedText,
      }, chunks);

      res.json({
        id: created.document.id,
        board: created.document.board,
        level: created.document.level,
        syllabusCode: created.document.syllabusCode,
        filename: created.document.filename,
        uploadedAt: created.document.uploadedAt,
        chunkCount: created.chunks.length,
      });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Failed to upload syllabus PDF" });
    }
  });

  // Copilot chat for tutor quiz builder
  app.post("/api/tutor/copilot-chat", requireTutor, async (req, res) => {
    try {
      const { message, documentIds, chatHistory, syllabusSelection, includeGraphQuestions, assessmentContext, draftQuestions } = req.body;
      const allowGraphs = includeGraphQuestions === true;
      // draftQuestions is the current in-progress question list (may be empty for new assessments)
      const currentDraft: DraftQuestion[] = Array.isArray(draftQuestions) ? draftQuestions : [];
      if (!message) return res.status(400).json({ message: "message is required" });

      const text = String(message);
      // Only ask for clarification when the message is a completely blank slate:
      // all three context fields are absent AND the message has no implicit topic.
      // If the user has filled in even one field (Subject/Level/Syllabus via the
      // builder form), the enriched message will contain it and we proceed.
      const hasSubject  = /subject\s*:/i.test(text);
      const hasLevel    = /level\s*:/i.test(text);
      const hasSyllabus = /syllabus\s*:/i.test(text);
      const hasImplicitTopic = /about\s+\w+/i.test(text);
      const hasAnyContext = hasSubject || hasLevel || hasSyllabus || hasImplicitTopic;
      if (!hasAnyContext) {
        return res.json({
          reply: "To generate relevant questions, please fill in at least one of the Subject, Level, or Syllabus fields on the left — or mention the topic in your message (e.g. \"Generate 5 questions about Newton's laws\").",
          drafts: [],
          summary: buildCopilotSummary({ drafts: [] }),
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

      let syllabusContextLabel = "";
      if (syllabusSelection?.board && syllabusSelection?.level && syllabusSelection?.syllabusCode) {
        const syllabusDocument = await storage.getSyllabusDocumentBySelection({
          board: String(syllabusSelection.board),
          level: String(syllabusSelection.level),
          syllabusCode: String(syllabusSelection.syllabusCode),
          tutorId: (req as any).tutorId,
        });
        if (!syllabusDocument) {
          return res.status(404).json({ message: "Selected syllabus could not be found" });
        }
        syllabusContextLabel = `${syllabusDocument.board} ${syllabusDocument.level} ${syllabusDocument.syllabusCode}`;
        const relevantChunks = scoreSyllabusChunks(syllabusDocument.chunks, text);
        supportingText += `\nSelected syllabus: ${syllabusContextLabel}\n${relevantChunks.join("\n---\n") || syllabusDocument.extractedText.slice(0, 2000)}`;
      }

      const paperCode = text.match(/\b\d{4}\/v\d\/\d{4}\b/i)?.[0];
      if (paperCode) {
        supportingText += `\n${await fetchPaperContext(paperCode)}`;
      }

      // Strip server-appended mechanical suffixes from AI turns before feeding
      // them back to the model — "**Draft action:**" and "**Verified:**" blocks
      // make the AI think the draft is already in the target state and return NONE.
      const stripMechanicalSuffixes = (text: string): string =>
        text
          .replace(/\n\n\*\*Draft action:\*\*[\s\S]*$/, "")
          .replace(/\n\n\*\*Verified:\*\*[\s\S]*$/, "")
          .replace(/\n\n⚠️ \*\*Graph validation failed:\*\*[\s\S]*$/, "")
          .trim();

      const memoryTranscript = Array.isArray(chatHistory)
        ? chatHistory
          .filter((item: any) => item && (item.role === "user" || item.role === "ai"))
          .slice(-8)
          .map((item: any) => {
            const text = String(item.text || "");
            const clean = item.role === "ai" ? stripMechanicalSuffixes(text) : text;
            return `${String(item.role).toUpperCase()}: ${clean}`;
          })
          .join("\n")
        : "";

      // ── Build draft context block ─────────────────────────────────────────
      let draftContextBlock = "";
      if (currentDraft.length > 0) {
        const currentGraphCount = currentDraft.filter((q) => q.questionType === "graph" && q.graphSpec != null).length;
        const draftLines: string[] = ["=== CURRENT DRAFT QUESTIONS (do NOT regenerate these unless the user asks) ==="];
        currentDraft.forEach((q, i) => {
          const graphFlag = q.questionType === "graph" && q.graphSpec != null ? " [HAS_GRAPH]" : "";
          draftLines.push(`Q${i + 1} [${q.questionType}${graphFlag}] ${q.stem.slice(0, 100)}${q.stem.length > 100 ? "…" : ""}`);
          draftLines.push(`   Options: ${q.options.join(" | ")}`);
          draftLines.push(`   Correct: ${q.correctAnswer} | Marks: ${q.marks} | Difficulty: ${q.difficultyTag || "—"} | Topic: ${q.topicTag || "—"}`);
        });
        draftLines.push(`Total draft questions: ${currentDraft.length} | Graph questions: ${currentGraphCount}`);
        draftLines.push("=================================================================");
        draftContextBlock = draftLines.join("\n");
      }

      // ── Build assessment metadata snapshot ───────────────────────────────
      let assessmentSnapshot = "";
      if (assessmentContext && typeof assessmentContext === "object") {
        const ac = assessmentContext as Record<string, any>;
        const lines: string[] = ["=== ASSESSMENT METADATA ==="];
        if (ac.assessmentMeta) {
          const m = ac.assessmentMeta;
          lines.push(`Title: "${m.title || "Untitled"}" | Subject: ${m.subject || "—"} | Level: ${m.level || "—"} | Syllabus: ${m.syllabus || "—"}`);
        }
        if (ac.difficultySpread && typeof ac.difficultySpread === "object") {
          const ds = ac.difficultySpread as Record<string, number>;
          lines.push(`Difficulty spread in draft: easy=${ds.easy ?? 0}, medium=${ds.medium ?? 0}, hard=${ds.hard ?? 0}`);
        }
        lines.push("===========================");
        assessmentSnapshot = lines.join("\n");
      }

      const copilotSystemPrompt = `You are SOMA Copilot, an expert mathematics assessment generator for the MCEC platform.

You operate on a DRAFT layer — questions are NOT saved to the database until the tutor clicks "Save & Publish".
Your job is to return a JSON object that describes what action to take on the draft.

## RESPONSE FORMAT (always return exactly this JSON structure):
{
  "reply": "<friendly conversational reply explaining what you did>",
  "action": "<one of: ADD | REPLACE_ALL | REPLACE_SELECTED | DELETE | REORDER | NONE>",
  "questions": [ <array of question objects — see below> ],
  "positions": [ <array of 1-based integer positions — see below> ]
}

## ACTION TYPES:
- ADD: Append new questions to the end of the draft. Put new questions in "questions", leave "positions" empty.
- REPLACE_ALL: Replace the entire draft with new questions. Put all new questions in "questions", leave "positions" empty.
- REPLACE_SELECTED: Replace specific questions. "positions[i]" (1-based) is replaced by "questions[i]". Both arrays must be the same length.
- DELETE: Remove specific questions by position. Put 1-based positions in "positions", leave "questions" empty.
- REORDER: Reorder all questions. "positions" must be a complete permutation of [1..N] specifying the new order. "questions" is empty.
- NONE: No question changes (e.g. for questions/clarifications). Empty "questions" and "positions".

## CHOOSE ACTION BASED ON USER INTENT:
- "add N questions" / "generate more" → ADD
- "replace all questions" / "start over" / "regenerate everything" → REPLACE_ALL
- "make question 3 harder" / "fix Q2" / "replace questions 1 and 4" → REPLACE_SELECTED
- "delete question 2" / "remove questions 3 and 5" → DELETE
- "move Q3 to the top" / "reorder so easy questions come first" → REORDER
- No question change needed → NONE

## QUESTION OBJECT FORMAT (for ADD, REPLACE_ALL, REPLACE_SELECTED):
Each question MUST have:
- prompt_text: the question text (non-empty)
- options: array of exactly 4 distinct answer strings
- correct_answer: one of the 4 options verbatim
- marks_worth: integer 1-10
- explanation: non-empty string
- topic_tag, subtopic_tag, difficulty_tag (easy/medium/hard)
- question_type: "multiple_choice" or "graph"
${allowGraphs
  ? `Graph questions are ALLOWED for ANY subject — not just Maths. Physics, Economics, Biology, Chemistry graphs are all valid.
A graph question is still a full MCQ — it must have all the fields above PLUS a valid graph_spec.

SINGLE-CURVE graph (use "equation"):
{
  "question_type": "graph",
  "prompt_text": "The graph shows an object's velocity over time. What is the acceleration?",
  "options": ["2 m/s²", "3 m/s²", "4 m/s²", "6 m/s²"],
  "correct_answer": "3 m/s²",
  "marks_worth": 2,
  "explanation": "The gradient of v-t graph = acceleration. Rise/run = (12−0)/(4−0) = 3 m/s².",
  "graph_spec": {
    "plotType": "line",
    "equation": "3*x",
    "xRange": [0, 5],
    "yRange": [0, 16],
    "axisLabels": {"x": "t (s)", "y": "v (m/s)"},
    "showGrid": true,
    "tickInterval": 1
  }
}

MULTI-CURVE graph (use "curves" array — for 2 to 4 curves on one graph):
{
  "question_type": "graph",
  "prompt_text": "The supply and demand curves are shown. At what price does the market reach equilibrium?",
  "options": ["$2", "$4", "$6", "$8"],
  "correct_answer": "$4",
  "marks_worth": 3,
  "explanation": "Equilibrium is where supply = demand. Setting 2x+1 = -x+7 gives x=2, y=5, so price = $4.",
  "graph_spec": {
    "plotType": "line",
    "curves": [
      {"equation": "2*x + 1", "label": "Supply"},
      {"equation": "-x + 7",  "label": "Demand"}
    ],
    "xRange": [0, 5],
    "yRange": [0, 10],
    "axisLabels": {"x": "Quantity", "y": "Price ($)"},
    "showGrid": true,
    "tickInterval": 1
  }
}

Subject-specific graph ideas:
- Physics: velocity-time (gradient=acceleration), force-extension (Hooke's law), I-V characteristics
- Economics: supply & demand (2 curves), cost curves (MC, AC, ATC on one graph)
- Biology: enzyme activity vs temperature/pH, population growth curves
- Chemistry: concentration vs time, titration curves
- Maths: comparing two functions, finding intersections, transformations

CRITICAL graph_spec RULES — violating any of these makes the question INVALID:
1. xRange and yRange MUST be JSON arrays [min, max] — NEVER objects like {"min":-5,"max":5}
2. Use "equation" for single curve OR "curves" (array with "equation"+"label" per entry) for multi-curve
3. equations use * for multiplication: write "2*x + 1" NOT "2x+1", write "-x^2 + 3" NOT "-x² + 3"
4. All equations use variable x only
5. graph_spec is REQUIRED — do NOT omit it or leave it null/empty
6. Set question_type to "graph" ONLY when you have included a valid graph_spec`
  : `question_type MUST be "multiple_choice" for every question. Do NOT include graph questions or graph_spec.`}

## CRITICAL RULES:
- correct_answer must exactly match one of the 4 options (copy verbatim)
- Do not regenerate unchanged questions — only return questions for ADD/REPLACE operations
- For DELETE and REORDER, "questions" must be an empty array []`;

      const userPrompt = [
        draftContextBlock || "(Draft is currently empty — no questions yet)",
        assessmentSnapshot,
        `Current request from tutor:\n${text}`,
        `Conversation memory:\n${memoryTranscript || "No previous turns."}`,
        `Supporting context:\n${supportingText || "No extra context."}`,
      ].filter(Boolean).join("\n\n");

      const { data, metadata } = await generateWithFallback(copilotSystemPrompt, userPrompt);

      const structured = extractStructuredCopilotResponse(data);

      // ── Step 1: Normalise raw question objects into DraftQuestion shape,
      //    tracking which attempted to be graph questions but failed validation
      type NormResult = { normalised: DraftQuestion | null; attemptedGraph: boolean; isValidGraph: boolean };
      const normResults: NormResult[] = structured.questions.map((q: any) => {
        const normalised = normaliseToDraftQuestion(q);
        const attemptedGraph = q.question_type === "graph" || (q.graph_spec && typeof q.graph_spec === "object");
        const isValidGraph = normalised?.questionType === "graph" && normalised?.graphSpec != null;
        return { normalised, attemptedGraph, isValidGraph };
      });

      let normalisedQuestions: DraftQuestion[] = normResults
        .map((r) => r.normalised)
        .filter((q): q is DraftQuestion => q !== null)
        .filter((q) => allowGraphs || q.questionType !== "graph");

      // ── Step 2: Graph shortfall detection + targeted retry
      const requestedAsGraphCount = normResults.filter((r) => r.attemptedGraph).length;
      const validGraphAfterNorm = normalisedQuestions.filter((q) => q.questionType === "graph").length;
      const graphShortfall = requestedAsGraphCount - validGraphAfterNorm;
      const graphRequest = isGraphRequestMessage(text);

      if (allowGraphs && graphRequest && graphShortfall > 0) {
        // Some graph questions failed repairGraphSpec — retry with an explicit spec prompt
        const retryUserPrompt = `Generate exactly ${graphShortfall} graph question${graphShortfall !== 1 ? "s" : ""} on this topic: ${text}\n\nReturn a JSON object with key "questions" containing the graph questions.`;
        try {
          const { data: retryData } = await generateWithFallback(GRAPH_RETRY_SYSTEM_PROMPT, retryUserPrompt);
          const retryStructured = extractStructuredCopilotResponse(retryData);
          const retryGraphQuestions: DraftQuestion[] = retryStructured.questions
            .map((q: any) => normaliseToDraftQuestion(q))
            .filter((q): q is DraftQuestion => q !== null && q.questionType === "graph" && q.graphSpec != null);

          if (retryGraphQuestions.length > 0) {
            // Swap failed graph slots with valid retry results
            let retryIdx = 0;
            const merged: DraftQuestion[] = [];
            for (const r of normResults) {
              if (!r.normalised) continue;
              if (r.attemptedGraph && !r.isValidGraph && retryIdx < retryGraphQuestions.length) {
                merged.push(retryGraphQuestions[retryIdx++]);
              } else {
                merged.push(r.normalised);
              }
            }
            // Append any remaining retry graph questions if there were fewer failed slots than retry results
            while (retryIdx < retryGraphQuestions.length) {
              merged.push(retryGraphQuestions[retryIdx++]);
            }
            normalisedQuestions = merged.filter((q) => allowGraphs || q.questionType !== "graph");
          }
        } catch {
          // Retry failed — proceed with what we have
        }
      }

      // ── Step 3: Simulate the final draft state on the server to compute
      //    verified graph positions (what the client will actually see)
      const simulatedDraft = applyDraftActionServer(
        currentDraft,
        structured.action,
        normalisedQuestions,
        structured.positions,
      );
      const graphPositionsInDraft = simulatedDraft
        .map((q, i) => ({ pos: i + 1, isGraph: q.questionType === "graph" && q.graphSpec != null }))
        .filter((x) => x.isGraph)
        .map((x) => x.pos);
      const finalGraphCount = graphPositionsInDraft.length;

      // ── Step 4: Build an honest verified reply (based on actual draft state,
      //    not the AI's claimed narrative)
      const actionVerb = {
        ADD: `Added ${normalisedQuestions.length} question${normalisedQuestions.length !== 1 ? "s" : ""}`,
        REPLACE_ALL: `Replaced all questions (${normalisedQuestions.length} new)`,
        REPLACE_SELECTED: `Replaced ${normalisedQuestions.length} question${normalisedQuestions.length !== 1 ? "s" : ""}`,
        DELETE: `Removed ${structured.positions.length} question${structured.positions.length !== 1 ? "s" : ""}`,
        REORDER: "Reordered questions",
        NONE: "",
      }[structured.action];

      // How many valid graph questions are in the normalised result (after any retry)?
      const validGraphAfterRetry = normalisedQuestions.filter((q) => q.questionType === "graph" && q.graphSpec != null).length;

      // Verified graph state block — only shown when graphs are relevant
      let graphVerificationBlock = "";
      if (graphRequest || finalGraphCount > 0) {
        if (finalGraphCount > 0) {
          // Simulation found graph questions in the projected draft
          const posLabel = graphPositionsInDraft.length === 1 ? "position" : "positions";
          graphVerificationBlock =
            `\n\n**Verified:** draft has ${simulatedDraft.length} total question${simulatedDraft.length !== 1 ? "s" : ""}, ` +
            `graph question${finalGraphCount !== 1 ? "s" : ""} at ${posLabel} ${graphPositionsInDraft.join(", ")}.`;
        } else if (validGraphAfterRetry > 0 && simulatedDraft.length > 0) {
          // Normalization succeeded but simulation couldn't place them (e.g. REPLACE_SELECTED out of range)
          const posLabel = validGraphAfterRetry === 1 ? "question" : "questions";
          graphVerificationBlock =
            `\n\n**Verified:** ${validGraphAfterRetry} graph ${posLabel} generated and ready to be applied to the draft.`;
        } else if (graphRequest && requestedAsGraphCount > 0 && validGraphAfterRetry === 0) {
          // Normalization completely failed — no valid graph questions at all
          graphVerificationBlock =
            `\n\n⚠️ **Graph validation failed:** the AI could not produce valid graph questions ` +
            `(the graph specification was malformed or missing). The draft was not changed for graph positions. ` +
            `Try again, or specify an equation explicitly (e.g. "y = 2x + 1").`;
        }
      }

      const replySuffix = actionVerb
        ? `\n\n**Draft action:** ${actionVerb}. Click "Save & Publish" when you're happy with the full set.`
        : "";

      const summary = buildCopilotSummary({
        drafts: normalisedQuestions.map((q) => ({
          prompt_text: q.stem,
          options: q.options,
          correct_answer: q.correctAnswer,
          marks_worth: q.marks,
          explanation: q.explanation,
          topic_tag: q.topicTag,
          subtopic_tag: q.subtopicTag,
          difficulty_tag: q.difficultyTag,
          question_type: q.questionType,
          graph_spec: q.graphSpec ?? undefined,
        })),
        syllabusContextLabel,
      });

      res.json({
        reply: `${structured.reply}${replySuffix}${graphVerificationBlock}`,
        action: structured.action,
        questions: normalisedQuestions,
        positions: structured.positions,
        // Legacy field for backward-compat (builder.tsx migration)
        drafts: normalisedQuestions.map((q) => ({
          prompt_text: q.stem,
          options: q.options,
          correct_answer: q.correctAnswer,
          marks_worth: q.marks,
          explanation: q.explanation,
          topic_tag: q.topicTag,
          subtopic_tag: q.subtopicTag,
          difficulty_tag: q.difficultyTag,
          question_type: q.questionType,
          graph_spec: q.graphSpec ?? undefined,
        })),
        summary,
        metadata,
        needsClarification: false,
      });
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

  app.get("/api/admin/session", async (req, res) => {
    const token = getAdminSessionToken(req, ADMIN_COOKIE_NAME);
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
        const user = await getAuthorizedUserFromBearer(supaToken, ["tutor", "super_admin"]);
        if (user) {
          return res.json({ authenticated: true });
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


  app.post("/api/upload-image", uploadImageLimiter, requireAdmin, (req, res) => {
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

      const quiz = await storage.getSomaQuiz(id);
      if (!quiz) return res.status(404).json({ message: "Quiz not found" });

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
