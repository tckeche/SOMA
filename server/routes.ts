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
  const rawAsym = r.asymptotes && typeof r.asymptotes === "object" ? (r.asymptotes as Record<string, unknown>) : null;
  const asymptotes = rawAsym ? {
    vertical: Array.isArray(rawAsym.vertical) ? rawAsym.vertical.map(Number).filter(Number.isFinite) : [],
    horizontal: Array.isArray(rawAsym.horizontal) ? rawAsym.horizontal.map(Number).filter(Number.isFinite) : [],
    oblique: Array.isArray(rawAsym.oblique) ? rawAsym.oblique.map(String).filter(Boolean) : [],
  } : undefined;
  const rawImplicit = r.implicit && typeof r.implicit === "object" ? (r.implicit as Record<string, unknown>) : null;
  const implicit =
    rawImplicit && String(rawImplicit.type || "") === "circle"
      ? {
        type: "circle" as const,
        h: Number(rawImplicit.h),
        k: Number(rawImplicit.k),
        r: Number(rawImplicit.r),
      }
      : rawImplicit && String(rawImplicit.type || "") === "equation" && String(rawImplicit.equation || "").trim()
        ? {
          type: "equation" as const,
          equation: String(rawImplicit.equation),
        }
        : undefined;
  const rawParametric = r.parametric && typeof r.parametric === "object" ? (r.parametric as Record<string, unknown>) : null;
  const parametric = rawParametric
    ? {
      xEquation: String(rawParametric.xEquation || rawParametric.x || ""),
      yEquation: String(rawParametric.yEquation || rawParametric.y || ""),
      tRange: Array.isArray(rawParametric.tRange)
        ? [Number(rawParametric.tRange[0]), Number(rawParametric.tRange[1])] as [number, number]
        : [Number((rawParametric as any).tMin), Number((rawParametric as any).tMax)] as [number, number],
    }
    : undefined;
  const piecewise = Array.isArray(r.piecewise)
    ? r.piecewise
      .map((seg: any) => ({
        equation: String(seg?.equation || ""),
        domain: Array.isArray(seg?.domain)
          ? [Number(seg.domain[0]), Number(seg.domain[1])] as [number, number]
          : [Number(seg?.xMin), Number(seg?.xMax)] as [number, number],
        label: seg?.label ? String(seg.label) : undefined,
      }))
      .filter((seg) => seg.equation && Number.isFinite(seg.domain[0]) && Number.isFinite(seg.domain[1]) && seg.domain[0] < seg.domain[1])
    : undefined;

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
    asymptotes,
    implicit,
    parametric: parametric && parametric.xEquation && parametric.yEquation ? parametric : undefined,
    piecewise: piecewise && piecewise.length > 0 ? piecewise : undefined,
    subjectPreset: typeof r.subjectPreset === "string" ? r.subjectPreset : undefined,
    graphKind: typeof r.graphKind === "string" ? r.graphKind : undefined,
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
const verificationResendAttempts = new Map<string, number>();
const verificationCodeStore = new Map<string, {
  id: string;
  codeHash: string;
  salt: string;
  expiresAt: number;
  usedAt: number | null;
  sentAt: number;
  attempts: number;
}>();

function getDraft(quizId: number): DraftQuestion[] {
  return draftStore.get(quizId)?.questions ?? [];
}

function setDraft(quizId: number, questions: DraftQuestion[]): void {
  draftStore.set(quizId, { questions, updatedAt: new Date() });
}

function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(code: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function make7DigitCode(): string {
  return `${crypto.randomInt(1000000, 10000000)}`;
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
        "label": "y = 2x + 1",
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
9. equations use variable x only (the renderer evaluates f(x))
10. RANGE CHECK — evaluate EVERY equation at xMin and xMax; set yRange to contain ALL y-values plus 10% padding. Example: x² on [-3,4] reaches y=16 at x=4, so yMin ≥ -2, yMax ≥ 18
11. SINGLE-CURVE LABEL — when using "equation" (not "curves"), you MUST also include a "label" field: a clean, human-readable string shown on the graph. Use standard math notation (not JS code). Examples:
    - equation: "Math.sin(x * Math.PI / 180)"  →  label: "y = sin x°"
    - equation: "2*x**2 - 3*x + 1"              →  label: "y = 2x² − 3x + 1"
    - equation: "Math.exp(x)"                   →  label: "y = eˣ"
    - equation: "Math.log(x)"                   →  label: "y = ln x"
    - equation: "3*x + 2"                        →  label: "y = 3x + 2"
12. VARIABLE NAMES IN LABELS — the label must use the same variable names as the question text. NEVER use generic "x" and "y" when the question uses real variables. Examples:
    - arc-length question (s = rθ) with axisLabels x="θ (rad)" y="s (cm)": label MUST be "s = rθ" (symbolic), NOT "y = 4x"
    - sector-area question (A = ½r²θ) with axisLabels x="r (cm)" y="A (cm²)": label MUST be "A = ½θr²" (symbolic)
    - velocity-time question: label "v = 3t", NOT "y = 3x"
    - perimeter question with P = r(2+θ): label "P = r(2+θ)", NOT "y = 3x"
13. DO NOT REVEAL THE ANSWER IN THE LABEL — if the question asks students to determine a value (gradient, radius, θ, etc.) by reading the graph, write the label symbolically. Example: question asks "find the radius from the slope" → label "s = rθ" not "s = 4θ" (which gives away r = 4).

MATH FORMATTING — MANDATORY:
ALL mathematical content in prompt_text, options, and explanation MUST use LaTeX delimiters.
- Inline math: $x^2 + 3$ (single dollar signs)
- Display/standalone math: $$\\frac{a}{b}$$ (double dollar signs)
- NEVER write maths without delimiters. WRONG: "2x + 1"  RIGHT: "$2x + 1$"
- IMPORTANT: The "equation" field inside graph_spec is a JavaScript expression — do NOT use LaTeX there.
- The "label" field inside graph_spec is plain text (Unicode math symbols like °, ², ³, π, ˣ are fine).`;

/** Fisher-Yates shuffle — returns a new shuffled array */
function shuffleOptions<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

  // Shuffle options so the correct answer is never pinned to position A.
  // The correctAnswer string is unchanged — it travels with the shuffle.
  opts = shuffleOptions(opts);

  // Determine question type and graphSpec
  // Always start as multiple_choice; upgrade to "graph" only when we have a valid spec
  let questionType: "multiple_choice" | "graph" = "multiple_choice";
  let graphSpec: import("@shared/schema").GraphQuestionSpec | null = null;
  if (raw.graph_spec) {
    const repaired = repairGraphSpec(raw.graph_spec);
    if (repaired) {
      graphSpec = repaired;
      questionType = "graph";
    }
    // If repair failed, stays as "multiple_choice" — prevents ghost "graph" questions with no spec
  }
  // Note: raw.question_type === "graph" without a graph_spec means the AI omitted the spec;
  // we treat it as multiple_choice so the draft count is honest (no blank graph slots)

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

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "tckeche@gmail.com";

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

/**
 * Walk the string and find the first balanced { ... } JSON object.
 * Returns the parsed object or null if no valid JSON object found.
 * This handles AI responses where JSON is wrapped in prose or markdown.
 */
function extractJsonObject(text: string): any | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          // This balanced block wasn't valid JSON — keep scanning
          start = -1;
        }
      }
    }
  }
  return null;
}

function parseCopilotObject(parsed: any): ParsedCopilotResponse | null {
  if (!parsed || typeof parsed !== "object") return null;
  const VALID_ACTIONS: CopilotActionType[] = ["ADD", "REPLACE_ALL", "REPLACE_SELECTED", "DELETE", "REORDER", "NONE"];
  const rawAction = typeof parsed.action === "string" ? parsed.action.toUpperCase().trim() : "";
  const action: CopilotActionType = VALID_ACTIONS.includes(rawAction as CopilotActionType)
    ? (rawAction as CopilotActionType)
    : "ADD";

  const reply: string =
    typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : "";

  const questions: any[] = Array.isArray(parsed.questions)
    ? parsed.questions
    : Array.isArray(parsed.drafts)
      ? parsed.drafts
      : [];

  const positions: number[] = Array.isArray(parsed.positions)
    ? parsed.positions.map(Number).filter((n: number) => Number.isInteger(n) && n >= 1)
    : [];

  // Accept as a structured response only if it has the key fields
  if (!reply && questions.length === 0 && action === "ADD") return null;

  return { reply: reply || "Here are your questions.", action, questions, positions };
}

function extractStructuredCopilotResponse(text: string): ParsedCopilotResponse {
  console.log(`[COPILOT_DEBUG] Raw AI response length: ${text.length} chars`);
  const EMPTY: ParsedCopilotResponse = { reply: "Assessment draft prepared.", action: "NONE", questions: [], positions: [] };

  // Strip markdown code fences then try direct parse
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // Attempt 1: Direct JSON.parse (handles clean responses)
  try {
    const parsed = JSON.parse(cleaned);
    const result = parseCopilotObject(parsed);
    if (result) {
      console.log(`[COPILOT_DEBUG] Parsed directly: action=${result.action}, questions=${result.questions.length}`);
      return result;
    }
  } catch { /* fall through */ }

  // Attempt 2: Extract first balanced JSON object from mixed text (handles prose-wrapped JSON)
  try {
    const obj = extractJsonObject(cleaned);
    if (obj) {
      const result = parseCopilotObject(obj);
      if (result) {
        console.log(`[COPILOT_DEBUG] Extracted JSON object from mixed text: action=${result.action}, questions=${result.questions.length}`);
        return result;
      }
    }
  } catch { /* fall through */ }

  // Attempt 3: Fall back to extracting a raw questions array
  const questions = extractJsonArray(cleaned) || [];
  if (questions.length > 0) {
    console.log(`[COPILOT_DEBUG] Extracted raw questions array: ${questions.length} questions`);
    return { ...EMPTY, action: "ADD", questions };
  }

  console.log(`[COPILOT_DEBUG] All extraction attempts failed — returning NONE fallback. First 200 chars: ${text.slice(0, 200)}`);
  return EMPTY;
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

    const systemPrompt = `You are a mathematics tutor speaking directly to one student.

Write in second person ("you"), with warmth and precision.
Be concise but personal and constructive.
Use short paragraphs and bullet points.
Return clean HTML using <h3>, <ul>, <li>, <p>, and <strong>.

CRITICAL: When referencing specific questions, you MUST use the sequential question numbers provided in the data (e.g., "Question 1", "Question 4"). Never invent numbers and never use database IDs like Q156.`;

    const scorePct = maxPossibleScore > 0 ? Math.round((totalScore / maxPossibleScore) * 100) : 0;
    const userPrompt = `Student scored ${totalScore}/${maxPossibleScore} (${scorePct}%).

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
      const user_metadata = req.body?.user_metadata as { display_name?: string; full_name?: string } | undefined;
      let id = "";
      let email = "";

      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const decoded = await verifySupabaseToken(authHeader.slice(7));
        if (!decoded?.sub || !decoded?.email) {
          return res.status(401).json({ message: "Invalid or expired token" });
        }
        id = decoded.sub;
        email = decoded.email;
      } else if (process.env.NODE_ENV !== "production") {
        // Legacy local/test fallback
        id = String(req.body?.id || "");
        email = String(req.body?.email || "");
      } else {
        return res.status(401).json({ message: "Authentication required" });
      }

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
      let userId = "";
      let email = "";
      let displayName: string | null = null;

      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const decoded = await verifySupabaseToken(authHeader.slice(7));
        if (!decoded?.sub || !decoded?.email) return res.status(401).json({ message: "Invalid or expired token" });
        userId = decoded.sub;
        email = decoded.email;
      } else if (process.env.NODE_ENV !== "production") {
        // Legacy local/test fallback
        userId = String(req.query.userId || "");
        email = String(req.query.email || "");
      } else {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!userId || !email) return res.status(400).json({ message: "userId required" });
      let user = await storage.getSomaUserById(userId);
      if (!user) {
        const role = determineRole(email);
        console.log(`[auth-me] auto-sync for missing user: email=${email} role=${role}`);
        const parsed = insertSomaUserSchema.parse({
          id: userId,
          email,
          displayName: displayName || email.split("@")[0],
          role,
        });
        user = await storage.upsertSomaUser(parsed);
      }
      if (!user) return res.status(404).json({ message: "User not found" });
      await storage.touchUserLastLogin(user.id);
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

  app.post("/api/auth/resend-verification", async (req, res) => {
    try {
      const email = canonicalEmail(String(req.body?.email || ""));
      if (!email) return res.status(400).json({ message: "Email is required", code: "VERIFICATION_EMAIL_REQUIRED" });
      const supabaseUrl = process.env.VITE_SUPABASE_URL;
      const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey) {
        return res.status(500).json({ message: "Verification service unavailable", code: "VERIFICATION_CONFIG_MISSING" });
      }

      const resp = await fetch(`${supabaseUrl}/auth/v1/resend`, {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        body: JSON.stringify({ type: "signup", email }),
      });
      const body = await resp.text();
      if (!resp.ok) {
        console.error("[verification-resend-failed]", { email, status: resp.status, body: body.slice(0, 220) });
        return res.status(502).json({ message: "Could not resend verification email. Please try again shortly.", code: "VERIFICATION_RESEND_FAILED" });
      }

      const attemptCount = (verificationResendAttempts.get(email) ?? 0) + 1;
      verificationResendAttempts.set(email, attemptCount);
      return res.json({ ok: true, attemptCount, canUseCodeFallback: attemptCount >= 3 });
    } catch (err: any) {
      console.error("[verification-resend-error]", err?.message || err);
      return res.status(500).json({ message: "Verification resend failed", code: "VERIFICATION_RESEND_EXCEPTION" });
    }
  });

  app.post("/api/auth/send-verification-code", async (req, res) => {
    try {
      const email = canonicalEmail(String(req.body?.email || ""));
      if (!email) return res.status(400).json({ message: "Email is required", code: "VERIFICATION_EMAIL_REQUIRED" });
      const resendAttempts = verificationResendAttempts.get(email) ?? 0;
      if (resendAttempts < 3) {
        return res.status(403).json({ message: "Fallback code unlocks after 3 failed resend attempts", code: "VERIFICATION_CODE_NOT_ELIGIBLE" });
      }

      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return res.status(500).json({ message: "Code delivery unavailable", code: "VERIFICATION_CODE_DELIVERY_UNAVAILABLE" });

      const now = Date.now();
      const existing = verificationCodeStore.get(email);
      if (existing && now - existing.sentAt < 60_000) {
        return res.status(429).json({ message: "Please wait before requesting another code.", code: "VERIFICATION_CODE_RATE_LIMIT" });
      }

      const code = make7DigitCode();
      const salt = crypto.randomBytes(16).toString("hex");
      const id = crypto.randomUUID();
      verificationCodeStore.set(email, {
        id,
        codeHash: hashCode(code, salt),
        salt,
        sentAt: now,
        expiresAt: now + 10 * 60_000,
        usedAt: null,
        attempts: 0,
      });

      const sendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || "SOMA <onboarding@resend.dev>",
          to: [email],
          subject: "Your SOMA verification code",
          html: `<p>Your SOMA verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes and can be used once.</p>`,
        }),
      });
      if (!sendResp.ok) {
        verificationCodeStore.delete(email);
        return res.status(502).json({ message: "Could not send verification code email.", code: "VERIFICATION_CODE_SEND_FAILED" });
      }
      return res.json({ ok: true, expiresInSeconds: 600 });
    } catch (err: any) {
      console.error("[verification-code-send-error]", err?.message || err);
      return res.status(500).json({ message: "Could not send verification code", code: "VERIFICATION_CODE_SEND_EXCEPTION" });
    }
  });

  app.post("/api/auth/verify-verification-code", async (req, res) => {
    try {
      const email = canonicalEmail(String(req.body?.email || ""));
      const code = String(req.body?.code || "").trim();
      if (!email || !/^\d{7}$/.test(code)) return res.status(400).json({ message: "Valid email and 7-digit code required", code: "VERIFICATION_CODE_INVALID_INPUT" });

      const record = verificationCodeStore.get(email);
      if (!record) return res.status(404).json({ message: "No active code found. Request a new code.", code: "VERIFICATION_CODE_NOT_FOUND" });
      if (record.usedAt) return res.status(409).json({ message: "This code has already been used.", code: "VERIFICATION_CODE_USED" });
      if (Date.now() > record.expiresAt) return res.status(410).json({ message: "This code has expired. Request a new code.", code: "VERIFICATION_CODE_EXPIRED" });
      if (record.attempts >= 5) return res.status(429).json({ message: "Too many invalid attempts. Request a new code.", code: "VERIFICATION_CODE_BRUTEFORCE_LOCK" });

      record.attempts += 1;
      if (hashCode(code, record.salt) !== record.codeHash) {
        verificationCodeStore.set(email, record);
        return res.status(401).json({ message: "Invalid code. Please check and try again.", code: "VERIFICATION_CODE_MISMATCH" });
      }

      const supabaseUrl = process.env.VITE_SUPABASE_URL;
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !serviceRole) return res.status(500).json({ message: "Server verification config missing", code: "VERIFICATION_ADMIN_CONFIG_MISSING" });

      let targetUserId = "";
      for (let page = 1; !targetUserId; page += 1) {
        const usersResp = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`, {
          headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
        });
        if (!usersResp.ok) break;
        const usersData = await usersResp.json();
        const users = Array.isArray(usersData?.users) ? usersData.users : [];
        if (users.length === 0) break;
        const matched = users.find((u: any) => canonicalEmail(String(u.email || "")) === email);
        if (matched?.id) targetUserId = matched.id;
      }
      if (!targetUserId) return res.status(404).json({ message: "Account not found for this email", code: "VERIFICATION_USER_NOT_FOUND" });

      const confirmResp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${targetUserId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
        body: JSON.stringify({ email_confirm: true }),
      });
      if (!confirmResp.ok) {
        const body = await confirmResp.text();
        console.error("[verification-code-confirm-failed]", body.slice(0, 240));
        return res.status(502).json({ message: "Could not confirm account from code.", code: "VERIFICATION_CONFIRM_FAILED" });
      }

      record.usedAt = Date.now();
      verificationCodeStore.set(email, record);
      return res.json({ ok: true, message: "Code accepted. Your email is now verified. You can log in." });
    } catch (err: any) {
      console.error("[verification-code-verify-error]", err?.message || err);
      return res.status(500).json({ message: "Code verification failed", code: "VERIFICATION_CODE_VERIFY_EXCEPTION" });
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

      // Calculate actual max grade from question marks (0 if no questions — do not fallback to 100)
      const questions = await storage.getSomaQuestionsByQuizId(quizId);
      const maxGrade = questions.reduce((sum, q) => sum + q.marks, 0);

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

      // Prefer the server-side in-memory draft (most authoritative).
      // Fall back to client-sent questions in the request body — this handles the case
      // where the server was restarted (in-memory draft lost) or an earlier syncDraft
      // call failed silently. The client always sends its local draft for safety.
      let draft = getDraft(quizId);
      if (draft.length === 0 && Array.isArray(req.body?.questions) && req.body.questions.length > 0) {
        console.log(`[PUBLISH] Server draftStore empty for quiz ${quizId} — using ${req.body.questions.length} client-sent questions as fallback`);
        draft = req.body.questions as DraftQuestion[];
        // Persist the client draft to the server store so it's canonical
        setDraft(quizId, draft);
      }
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

      // Atomically replace all questions in a DB transaction (delete + insert as one unit)
      // so a failed insert cannot leave the quiz without any questions.
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

      const saved = await storage.publishSomaQuestionsTransactional(quizId, mapped);

      // Clear in-memory draft only after DB commit succeeded
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

      // SHA-256 dedup: prevent uploading the exact same PDF content twice
      const contentHash = crypto.createHash("sha256").update(extractedText).digest("hex");
      const existingDoc = await storage.getSyllabusDocumentByHash(contentHash);
      if (existingDoc) {
        const existingChunks = await storage.getSyllabusDocumentBySelection({
          board: existingDoc.board,
          level: existingDoc.level,
          syllabusCode: existingDoc.syllabusCode,
        });
        return res.json({
          id: existingDoc.id,
          board: existingDoc.board,
          level: existingDoc.level,
          syllabusCode: existingDoc.syllabusCode,
          filename: existingDoc.filename,
          uploadedAt: existingDoc.uploadedAt,
          chunkCount: existingChunks?.chunks.length ?? 0,
          duplicate: true,
          message: "This document has already been uploaded.",
        });
      }

      const chunks = buildSyllabusChunks(extractedText);
      const created = await storage.createSyllabusDocument({
        tutorId: (req as any).tutorId ?? null,
        board: String(board).trim(),
        level: String(level).trim(),
        syllabusCode: String(syllabusCode).trim(),
        filename: req.file.originalname,
        extractedText,
        contentHash,
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
      const { message, chatHistory, syllabusSelection, includeGraphQuestions, assessmentContext, draftQuestions } = req.body;
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

CRITICAL OUTPUT RULE: Your ENTIRE response must be a single valid JSON object. Do NOT write any prose, markdown, or explanation outside the JSON. All explanations go inside the "reply" field within the JSON. Do NOT start with text like "Here are your questions:" — start immediately with the opening "{".

You operate on a DRAFT layer — questions are NOT saved to the database until the tutor clicks "Save & Publish".
Your job is to return a JSON object that describes what action to take on the draft.

## RESPONSE FORMAT (your ENTIRE response must be exactly this JSON structure — nothing before or after):
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

## DEFAULT DIFFICULTY RULE:
Unless the tutor explicitly specifies a different mix, default to:
- 25% easy
- 50% medium
- 25% hard
Hard questions must require reasoning/application, not recall only.

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
    "label": "v = 3t",
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
6. Set question_type to "graph" ONLY when you have included a valid graph_spec
7. RANGE CHECK — before setting yRange, evaluate every equation at xMin AND xMax to find the true y-min and y-max; set yRange with at least 10% padding so NO curve is clipped. Example: y=x² on xRange[-3,4] reaches y=16 at x=4, so yRange must be at least [-1,18] not [-1,10]
8. Keep xRange and yRange spans within a 3:1 ratio of each other (avoid extreme aspect ratios)
9. SINGLE-CURVE LABEL — when using "equation" (not "curves"), you MUST include a "label" field with a clean, human-readable name for the curve shown on the graph. Use standard math notation — NOT raw JavaScript. Examples:
   - "equation": "Math.sin(x * Math.PI / 180)"  →  "label": "y = sin x°"
   - "equation": "2*x**2 - 3*x + 1"              →  "label": "y = 2x² − 3x + 1"
   - "equation": "Math.exp(x)"                   →  "label": "y = eˣ"
   - "equation": "Math.log(x)"                   →  "label": "y = ln x"
   - "equation": "3*x"                            →  "label": "v = 3t"  (use real variable names from context)
10. VARIABLE NAMES IN LABELS — the label MUST use the same variable names as the question text. NEVER use generic "x" / "y" when the question uses real-world variables. Match the axisLabels exactly. Examples:
    - axisLabels x="θ (rad)" y="s (cm)" → label "s = rθ" (NOT "y = 4x")
    - axisLabels x="r (cm)"  y="A (cm²)" → label "A = ½θr²" (NOT "y = 0.75x²")
    - axisLabels x="t (s)"   y="v (m/s)" → label "v = 3t" (NOT "y = 3x")
11. DO NOT REVEAL THE ANSWER IN THE LABEL — if the question asks the student to read a value (radius, gradient, θ, etc.) from the graph, write the label with SYMBOLIC notation. Example: question asks "find the radius" → label "s = rθ", NOT "s = 4θ" (which gives away r = 4).`
  : `question_type MUST be "multiple_choice" for every question. Do NOT include graph questions or graph_spec.`}

## MATH FORMATTING — MANDATORY:
ALL mathematical content in prompt_text, options, and explanation MUST use LaTeX delimiters.
- Inline math: $x^2 + 3x - 5$ (single dollar signs, within a sentence)
- Display math: $$\\frac{a}{b} = c$$ (double dollar signs, for standalone equations)
- Examples of CORRECT formatting:
  - prompt_text: "Find the value of $x$ when $2x + 3 = 7$."
  - option: "$x = 2$"
  - explanation: "Rearranging: $2x = 4$, so $x = 2$."
- NEVER write maths without delimiters. WRONG: "2x + 3 = 7"  RIGHT: "$2x + 3 = 7$"
- Use proper LaTeX: $\\frac{1}{2}$ for fractions, $x^{-2}$ for powers, $\\sqrt{x}$ for roots
- IMPORTANT: The "equation" field inside graph_spec is a JavaScript expression (e.g. "2*x + 1") — do NOT use LaTeX delimiters there. LaTeX is only for prompt_text, options, and explanation.
- The "label" field inside graph_spec is plain text with Unicode math notation (e.g. "y = sin x°", "y = x²") — no LaTeX, no JS code.

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

      console.log(`[COPILOT_DEBUG] Structured response: action=${structured.action}, raw_questions=${structured.questions.length}, draftSize=${currentDraft.length}`);

      // ── Step 1: Normalise raw question objects into DraftQuestion shape,
      //    tracking which attempted to be graph questions but failed validation
      type NormResult = { normalised: DraftQuestion | null; attemptedGraph: boolean; isValidGraph: boolean };
      const normResults: NormResult[] = structured.questions.map((q: any) => {
        const normalised = normaliseToDraftQuestion(q);
        const attemptedGraph = q.question_type === "graph" || (q.graph_spec && typeof q.graph_spec === "object");
        const isValidGraph = normalised?.questionType === "graph" && normalised?.graphSpec != null;
        if (attemptedGraph && !isValidGraph) {
          console.log(`[GRAPH_DEBUG] Graph question failed validation — stem: "${String(q.prompt_text || q.stem || "").slice(0, 60)}", graph_spec keys: ${q.graph_spec ? Object.keys(q.graph_spec).join(",") : "missing"}`);
        }
        return { normalised, attemptedGraph, isValidGraph };
      });

      let normalisedQuestions: DraftQuestion[] = normResults
        .map((r) => r.normalised)
        .filter((q): q is DraftQuestion => q !== null)
        .filter((q) => allowGraphs || q.questionType !== "graph");

      console.log(`[DRAFT_DEBUG] After normalization: total=${normalisedQuestions.length}, graphs=${normalisedQuestions.filter((q) => q.questionType === "graph").length}`);

      // ── Step 2: Graph shortfall detection + targeted retry
      const requestedAsGraphCount = normResults.filter((r) => r.attemptedGraph).length;
      const validGraphAfterNorm = normalisedQuestions.filter((q) => q.questionType === "graph").length;
      const graphShortfall = requestedAsGraphCount - validGraphAfterNorm;
      const graphRequest = isGraphRequestMessage(text);

      if (requestedAsGraphCount > 0) {
        console.log(`[GRAPH_DEBUG] Requested as graph: ${requestedAsGraphCount}, valid after norm: ${validGraphAfterNorm}, shortfall: ${graphShortfall}, retry needed: ${allowGraphs && graphRequest && graphShortfall > 0}`);
      }

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
      const beforeCount = currentDraft.length;
      const afterCount = simulatedDraft.length;
      const changed = JSON.stringify(currentDraft) !== JSON.stringify(simulatedDraft);
      const replaceablePositions = structured.positions
        .map((p) => p - 1)
        .filter((idx) => idx >= 0 && idx < currentDraft.length).length;
      const appliedCount = ({
        ADD: normalisedQuestions.length,
        REPLACE_ALL: normalisedQuestions.length,
        REPLACE_SELECTED: Math.min(replaceablePositions, normalisedQuestions.length),
        DELETE: beforeCount - afterCount,
        REORDER: changed ? beforeCount : 0,
        NONE: 0,
      } as Record<CopilotActionType, number>)[structured.action];
      const graphPositionsInDraft = simulatedDraft
        .map((q, i) => ({ pos: i + 1, isGraph: q.questionType === "graph" && q.graphSpec != null }))
        .filter((x) => x.isGraph)
        .map((x) => x.pos);
      const finalGraphCount = graphPositionsInDraft.length;

      console.log(`[DRAFT_DEBUG] Simulated draft: total=${simulatedDraft.length}, graphPositions=[${graphPositionsInDraft.join(",")}], currentDraftBefore=${currentDraft.length}`);

      // ── Step 4: Build an honest verified reply (based on actual draft state,
      //    not the AI's claimed narrative)
      const actionVerb = {
        ADD: `Added ${appliedCount} question${appliedCount !== 1 ? "s" : ""}`,
        REPLACE_ALL: `Replaced draft with ${appliedCount} question${appliedCount !== 1 ? "s" : ""}`,
        REPLACE_SELECTED: `Replaced ${appliedCount} question${appliedCount !== 1 ? "s" : ""}`,
        DELETE: `Removed ${appliedCount} question${appliedCount !== 1 ? "s" : ""}`,
        REORDER: appliedCount > 0 ? "Reordered draft questions" : "Could not reorder draft with the provided positions",
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

      const verificationState: "generation_failed" | "partial_success" | "validation_failed" | "ready_for_review" = (
        structured.questions.length > 0 && normalisedQuestions.length === 0
      ) ? "validation_failed" : (
        afterCount === 0
      ) ? "generation_failed" : (
        structured.action === "NONE" || appliedCount === 0
      ) ? "generation_failed" : (
        structured.action === "REPLACE_SELECTED" && appliedCount < normalisedQuestions.length
      ) ? "partial_success" : "ready_for_review";

      const reviewReady = afterCount > 0;
      const replySuffix = actionVerb
        ? `\n\n**Draft action:** ${actionVerb}. Draft count is now ${afterCount}. ${reviewReady ? 'Open Review to inspect questions, then publish when satisfied.' : 'No reviewable questions are currently in draft.'}`
        : `\n\n**Draft action:** No changes were applied to your draft.`;

      const summary = buildCopilotSummary({
        drafts: normalisedQuestions.map((q) => ({
          prompt_text: q.stem,
          options: q.options,
          correct_answer: q.correctAnswer,
          marks_worth: q.marks,
          explanation: q.explanation,
          topic_tag: q.topicTag ?? undefined,
          subtopic_tag: q.subtopicTag ?? undefined,
          difficulty_tag: q.difficultyTag ?? undefined,
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
        verification: {
          state: verificationState,
          beforeCount,
          afterCount,
          appliedCount,
          reviewReady,
          persistedToDatabase: false,
          persistedToDraftStore: changed,
        },
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

  app.get("/api/super-admin/tutors", requireSuperAdmin, async (_req, res) => {
    try {
      const tutors = await storage.getTutorDashboardSummaries();
      res.json(tutors);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch tutor dashboard data" });
    }
  });

  app.get("/api/super-admin/tutors/:tutorId", requireSuperAdmin, async (req, res) => {
    try {
      const tutorId = String(req.params.tutorId || "");
      if (!tutorId) return res.status(400).json({ message: "Invalid tutor ID" });
      const detail = await storage.getTutorDashboardDetail(tutorId);
      if (!detail) return res.status(404).json({ message: "Tutor not found" });
      res.json(detail);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch tutor detail" });
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
    subtopic: z.string().optional(),
    questionCount: z.number().int().min(1).max(40).default(8),
    difficultyDistribution: z.object({
      easy: z.number().min(0).max(100),
      medium: z.number().min(0).max(100),
      hard: z.number().min(0).max(100),
    }).optional(),
  });

  app.post("/api/soma/generate", requireAdmin, async (req, res) => {
    try {
      const parsed = somaGenerateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { topic, title, curriculumContext, subject, syllabus, level, questionCount, difficultyDistribution, subtopic } = parsed.data;
      const quizTitle = title || `${topic} Quiz`;

      const result = await generateAuditedQuiz({
        topic,
        subject,
        syllabus,
        level,
        copilotPrompt: curriculumContext,
        questionCount,
        difficultyDistribution: difficultyDistribution ?? { easy: 25, medium: 50, hard: 25 },
        subtopic,
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

      const { topic, title, curriculumContext, subject, syllabus, level, questionCount, difficultyDistribution, subtopic } = parsed.data;
      const requestedStudentIds = sanitizeStudentIds(req.body?.assignTo);
      const quizTitle = title || `${topic} Quiz`;

      const result = await generateAuditedQuiz({
        topic, subject, syllabus, level,
        copilotPrompt: curriculumContext,
        questionCount,
        difficultyDistribution: difficultyDistribution ?? { easy: 25, medium: 50, hard: 25 },
        subtopic,
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

  app.post("/api/soma/quizzes/:id/submit", requireSupabaseAuth, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.id));
      if (isNaN(quizId)) return res.status(400).json({ message: "Invalid quiz ID" });

      const authUser = (req as any).authUser as { id: string | string[]; displayName?: string | null };
      const studentId = String(authUser.id);
      const { studentName, answers, startedAt } = req.body;
      if (!answers) {
        return res.status(400).json({ message: "Missing answers" });
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

      let report;
      try {
        report = await storage.createSomaReport({
          quizId,
          studentId,
          studentName: resolvedName,
          score: totalScore,
          status: "pending",
          answersJson: sanitizedAnswers,
          startedAt: parsedStartedAt && !isNaN(parsedStartedAt.getTime()) ? parsedStartedAt : null,
          completedAt: now,
        });
      } catch (dbErr: any) {
        // Handle DB-level unique constraint violation (race condition between concurrent submits)
        if (dbErr.code === "23505" || dbErr.message?.includes("unique") || dbErr.message?.includes("duplicate")) {
          return res.status(409).json({ message: "You have already submitted this quiz." });
        }
        throw dbErr;
      }

      res.json(report);

      // Mark quiz assignment as completed
      storage.updateQuizAssignmentStatus(quizId, studentId, "completed").catch(() => {});

      const maxPossibleScore = allQuestions.reduce((s, q) => s + q.marks, 0);
      runBackgroundGrading(report.id, allQuestions, answers, totalScore, maxPossibleScore).catch(() => {});
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/soma/quizzes/:id/check-submission", requireSupabaseAuth, async (req, res) => {
    try {
      const quizId = parseInt(String(req.params.id));
      if (isNaN(quizId)) {
        return res.status(400).json({ message: "quizId required" });
      }
      const studentId = String((req as any).authUser.id);
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
      const authUser = (req as any).authUser as { id: string | string[]; role: string };
      const authUserId = String(authUser.id);
      const isOwner = report.studentId === authUserId;
      const isSuperAdmin = authUser.role === "super_admin";

      if (!isOwner && !isSuperAdmin) {
        // Check if requester is a tutor who adopted this student
        if (authUser.role === "tutor" && report.studentId) {
          const adopted = await storage.getAdoptedStudents(authUserId);
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

  app.post("/api/soma/reports/:reportId/retry", requireSupabaseAuth, async (req, res) => {
    try {
      const reportId = parseInt(String(req.params.reportId));
      if (isNaN(reportId)) return res.status(400).json({ message: "Invalid report ID" });

      const report = await storage.getSomaReportById(reportId);
      if (!report) return res.status(404).json({ message: "Report not found" });
      const authUser = (req as any).authUser as { id: string | string[]; role: string };
      const authUserId = String(authUser.id);
      const isOwner = report.studentId === authUserId;
      const isSuperAdmin = authUser.role === "super_admin";
      let isTutorOfStudent = false;
      if (authUser.role === "tutor" && report.studentId) {
        const adopted = await storage.getAdoptedStudents(authUserId);
        isTutorOfStudent = adopted.some((s) => s.id === report.studentId);
      }
      if (!isOwner && !isSuperAdmin && !isTutorOfStudent) {
        return res.status(403).json({ message: "Forbidden: you do not have access to this report" });
      }

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

  app.post("/api/soma/global-tutor", requireSupabaseAuth, async (req, res) => {
    try {
      const authUser = (req as any).authUser as { id: string; role: string };
      const { message, studentId: requestedStudentId } = req.body;
      if (!message) return res.status(400).json({ message: "Message is required" });
      let studentId: string | null = null;
      if (authUser.role === "student") {
        studentId = authUser.id;
      } else if (typeof requestedStudentId === "string" && requestedStudentId.trim()) {
        if (authUser.role === "super_admin") {
          studentId = requestedStudentId.trim();
        } else if (authUser.role === "tutor") {
          const adopted = await storage.getAdoptedStudents(authUser.id);
          if (!adopted.some((s) => s.id === requestedStudentId.trim())) {
            return res.status(403).json({ message: "Forbidden: you do not have access to this student" });
          }
          studentId = requestedStudentId.trim();
        }
      }

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
