import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { generateWithFallback, callGoogle } from "./aiOrchestrator";
import Anthropic from "@anthropic-ai/sdk";
import { validateMathQuestion, parseOptionAsNumber } from "./mathValidator";

export const QuestionSchema = z.object({
  stem: z.string(),
  options: z.array(z.string()).length(4),
  correct_answer: z.string(),
  explanation: z.string().min(1),
  marks: z.number().int().min(1).max(10),
  difficulty_tag: z.enum(["easy", "medium", "hard"]).optional(),
  topic_tag: z.string().optional(),
  subtopic_tag: z.string().optional(),
});

export const QuizResultSchema = z.object({
  questions: z.array(QuestionSchema).min(1),
});

export type QuizResult = z.infer<typeof QuizResultSchema>;

export interface PipelineWarning {
  questionIndex: number;
  field: "stem" | "options" | "explanation" | "correct_answer" | "overall";
  issue: string;
  autoFixed: boolean;
}

export interface PipelineTelemetry {
  makerModel: string;
  checkerModel: string;
  polishModel: string | null;
  totalDurationMs: number;
}

export interface AuditedQuizResult {
  questions: QuizResult["questions"];
  warnings: PipelineWarning[];
  telemetry: PipelineTelemetry;
}

const GeminiCheckerResponseSchema = z.object({
  questions: z.array(QuestionSchema).min(1),
  warnings: z
    .array(
      z.object({
        questionIndex: z.number().int().min(1),
        field: z.enum(["stem", "options", "explanation", "correct_answer", "overall"]),
        issue: z.string(),
        autoFixed: z.boolean(),
      }),
    )
    .default([]),
});

export interface SomaGenerationContext {
  topic: string;
  subject: string;
  syllabus: string;
  level: string;
  copilotPrompt?: string;
  supportingDocText?: string;
  questionCount?: number;
  subtopic?: string;
  difficultyDistribution?: { easy: number; medium: number; hard: number };
}

const jsonSchema = zodToJsonSchema(QuizResultSchema, "QuizResult");

function extractJson(raw: string): QuizResult {
  return QuizResultSchema.parse(JSON.parse(raw));
}

function dedupeOptions(options: string[], preferred?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    const normalized = option.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(option.trim());
  }
  if (preferred && !out.some((o) => o.trim() === preferred.trim())) out.unshift(preferred.trim());
  while (out.length < 4) out.push(`Option ${out.length + 1}`);
  return out.slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// BLIND DUAL-VERIFY (the safety net that prevents wrong answers from shipping)
// ─────────────────────────────────────────────────────────────────────────────

const BlindAnswerSchema = z.object({
  questionIndex: z.number().int().min(1),
  answer: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const BlindResponseSchema = z.object({
  answers: z.array(BlindAnswerSchema),
});

type BlindResponse = z.infer<typeof BlindResponseSchema>;

export interface BlindVerificationResult {
  questions: QuizResult["questions"];
  warnings: PipelineWarning[];
  droppedCount: number;
  verificationStatus: "verified" | "partial" | "skipped" | "failed";
}

// Normalize two answer strings for case/whitespace/LaTeX-delim comparison.
function normalizeForComparison(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\$\$/g, "")
    .replace(/\$/g, "")
    .replace(/\\text\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\left|\\right/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Detect an option-letter answer like "A", "B)", "(C)", "option d".
// Returns 0-based index or null.
function extractLetterIndex(answer: string): number | null {
  const s = answer.trim().toLowerCase();
  // "a", "(a)", "a)", "a.", "a:"
  const direct = s.match(/^\(?([a-d])\)?\s*[.:)]?\s*$/);
  if (direct) return direct[1].charCodeAt(0) - 97;
  // "a) text", "(a) text", "a. text"
  const prefixed = s.match(/^\(?([a-d])\)?\s*[.:)]\s+/);
  if (prefixed) return prefixed[1].charCodeAt(0) - 97;
  // "option a"
  const worded = s.match(/^option\s+([a-d])\b/);
  if (worded) return worded[1].charCodeAt(0) - 97;
  return null;
}

// Strict equivalence matcher. Returns the index of the matching option, or null.
// No substring matching — that was the source of "pi" ⊂ "2pi" false positives.
function findMatchingOptionIndex(answer: string, options: string[]): number | null {
  if (!answer || !answer.trim()) return null;

  // 1. Normalized exact equality (case/whitespace/LaTeX-insensitive)
  const normAnswer = normalizeForComparison(answer);
  if (normAnswer) {
    for (let i = 0; i < options.length; i++) {
      if (normalizeForComparison(options[i]) === normAnswer) return i;
    }
  }

  // 2. Numeric equivalence (0.5 ≡ 1/2 ≡ 50/100, tolerant to rounding)
  const answerNum = parseOptionAsNumber(answer);
  if (answerNum !== null) {
    for (let i = 0; i < options.length; i++) {
      const optNum = parseOptionAsNumber(options[i]);
      if (optNum === null) continue;
      const tol = Math.max(1e-6, Math.abs(optNum) * 1e-4);
      if (Math.abs(answerNum - optNum) < tol) return i;
    }
  }

  // 3. Letter prefix fallback ("A", "Option B")
  const letterIdx = extractLetterIndex(answer);
  if (letterIdx !== null && letterIdx >= 0 && letterIdx < options.length) return letterIdx;

  return null;
}

async function runBlindSolverClaude(
  stems: Array<{ questionIndex: number; stem: string }>,
  context: SomaGenerationContext,
  apiKey: string,
): Promise<BlindResponse> {
  const anthropic = new Anthropic({ apiKey });
  const wrapped: any = zodToJsonSchema(BlindResponseSchema, "BlindResponse");
  const inner: any = wrapped?.definitions?.BlindResponse ?? zodToJsonSchema(BlindResponseSchema);
  const inputSchema: any = { ...inner, type: inner?.type || "object" };
  delete inputSchema.$schema;
  delete inputSchema.$ref;

  const systemPrompt = `You are an INDEPENDENT answer verifier for ${context.subject}.
Solve each question you are given SOLELY from its stem. No answer options are provided — do not assume any.
Return your best answer in its most natural form (a number, an expression, or a short phrase), plus a confidence score 0..1.
Be precise: if the question has multiple roots, return them all (e.g. "x = ±3" not just "3").`;

  const userPrompt = `Subject=${context.subject}; syllabus=${context.syllabus}; level=${context.level}; topic=${context.topic}${context.subtopic ? `; subtopic=${context.subtopic}` : ""}.
${JSON.stringify(stems, null, 2)}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8_192,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{
      name: "return_blind_answers",
      description: "Return each question's independently-derived answer.",
      input_schema: inputSchema,
    }],
    tool_choice: { type: "tool", name: "return_blind_answers" },
  });

  const toolBlock = response.content.find((b: any) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") throw new Error("Claude verifier returned no tool output");
  return BlindResponseSchema.parse(toolBlock.input);
}

async function runBlindSolverGemini(
  stems: Array<{ questionIndex: number; stem: string }>,
  context: SomaGenerationContext,
): Promise<BlindResponse> {
  const systemPrompt = `You are an INDEPENDENT answer verifier for ${context.subject}.
Solve each question SOLELY from its stem. No options are provided — do not invent any.
Return each answer in its most natural form (a number, expression, or short phrase).
If the answer is a set (e.g. "x = ±3"), return it fully — don't truncate.`;

  const userPrompt = `Subject=${context.subject}; syllabus=${context.syllabus}; level=${context.level}; topic=${context.topic}${context.subtopic ? `; subtopic=${context.subtopic}` : ""}.
${JSON.stringify(stems, null, 2)}`;

  const schema = zodToJsonSchema(BlindResponseSchema, "BlindResponse");
  const raw = await callGoogle("gemini-2.5-flash", systemPrompt, userPrompt, schema);
  return BlindResponseSchema.parse(JSON.parse(raw));
}

function dropUnverifiedWithReason(
  questions: QuizResult["questions"],
  reason: string,
): BlindVerificationResult {
  const kept: QuizResult["questions"] = [];
  const warnings: PipelineWarning[] = [];
  let droppedCount = 0;
  questions.forEach((q, i) => {
    const m = validateMathQuestion(q.stem, q.options, q.correct_answer);
    if (m.verifiable) {
      kept.push(q);
      return;
    }
    droppedCount++;
    warnings.push({
      questionIndex: i + 1,
      field: "correct_answer",
      issue: `Dropped (unverified): ${reason}`,
      autoFixed: true,
    });
  });
  return { questions: kept, warnings, droppedCount, verificationStatus: "failed" };
}

/**
 * SAFETY NET: ask Claude and Gemini INDEPENDENTLY to re-solve each question
 * from the STEM ONLY (no options, no proposed answer). A question is only
 * shipped when both verifiers agree on which option matches their independent
 * answer. Otherwise it is DROPPED.
 *
 * Decision table (per question):
 *   - Both map to SAME option as maker           → keep as-is
 *   - Both map to SAME option ≠ maker's answer   → OVERRIDE to blind consensus
 *   - Disagree, or either couldn't map, or APIs  → DROP (unsafe to ship)
 *     failed
 *
 * Math-verifiable questions bypass this — the deterministic CAS validator
 * owns them and is the final authority.
 */
export async function verifyQuestionsBlind(
  questions: QuizResult["questions"],
  context: SomaGenerationContext,
): Promise<BlindVerificationResult> {
  if (process.env.NODE_ENV === "test") {
    return { questions, warnings: [], droppedCount: 0, verificationStatus: "skipped" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!anthropicKey || !geminiKey) {
    return dropUnverifiedWithReason(questions, "verifier API keys missing (need both ANTHROPIC_API_KEY and GEMINI_API_KEY).");
  }

  // Math-verifiable items pass straight through — CAS owns them at Stage 4.
  const mathIdx = new Set<number>();
  const toVerify: Array<{ questionIndex: number; stem: string }> = [];
  questions.forEach((q, i) => {
    const m = validateMathQuestion(q.stem, q.options, q.correct_answer);
    if (m.verifiable) {
      mathIdx.add(i);
    } else {
      toVerify.push({ questionIndex: i + 1, stem: q.stem });
    }
  });

  if (toVerify.length === 0) {
    return { questions, warnings: [], droppedCount: 0, verificationStatus: "verified" };
  }

  const [claudeRes, geminiRes] = await Promise.allSettled([
    runBlindSolverClaude(toVerify, context, anthropicKey),
    runBlindSolverGemini(toVerify, context),
  ]);

  if (claudeRes.status === "rejected") {
    console.warn(`[BLIND_VERIFY][Claude] ${claudeRes.reason?.message || claudeRes.reason}`);
  }
  if (geminiRes.status === "rejected") {
    console.warn(`[BLIND_VERIFY][Gemini] ${geminiRes.reason?.message || geminiRes.reason}`);
  }

  const claudeParsed = claudeRes.status === "fulfilled" ? claudeRes.value : null;
  const geminiParsed = geminiRes.status === "fulfilled" ? geminiRes.value : null;

  if (!claudeParsed || !geminiParsed) {
    return dropUnverifiedWithReason(questions, "one or both blind verifiers failed — refusing to ship unverified non-math questions.");
  }

  const claudeByIdx = new Map(claudeParsed.answers.map((a) => [a.questionIndex, a]));
  const geminiByIdx = new Map(geminiParsed.answers.map((a) => [a.questionIndex, a]));

  const kept: QuizResult["questions"] = [];
  const warnings: PipelineWarning[] = [];
  let droppedCount = 0;

  questions.forEach((q, i) => {
    if (mathIdx.has(i)) {
      kept.push(q);
      return;
    }

    const questionIndex = i + 1;
    const claudeAns = claudeByIdx.get(questionIndex);
    const geminiAns = geminiByIdx.get(questionIndex);

    if (!claudeAns || !geminiAns) {
      droppedCount++;
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: "Dropped: one or both blind verifiers did not return an answer for this question.",
        autoFixed: true,
      });
      return;
    }

    const claudeIdx = findMatchingOptionIndex(claudeAns.answer, q.options);
    const geminiIdx = findMatchingOptionIndex(geminiAns.answer, q.options);

    if (claudeIdx === null || geminiIdx === null) {
      droppedCount++;
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: `Dropped: blind answers did not match any option (Claude="${claudeAns.answer}", Gemini="${geminiAns.answer}").`,
        autoFixed: true,
      });
      return;
    }

    if (claudeIdx !== geminiIdx) {
      droppedCount++;
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: `Dropped: verifiers disagreed (Claude→"${q.options[claudeIdx]}", Gemini→"${q.options[geminiIdx]}").`,
        autoFixed: true,
      });
      return;
    }

    const agreedOption = q.options[claudeIdx];
    if (q.correct_answer !== agreedOption) {
      kept.push({
        ...q,
        correct_answer: agreedOption,
        explanation: `Independent verification: Claude solved "${claudeAns.answer}", Gemini solved "${geminiAns.answer}" — both map to "${agreedOption}". Original answer "${q.correct_answer}" was overridden.`,
      });
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: `Overridden: Maker answer "${q.correct_answer}" replaced with blind-consensus answer "${agreedOption}".`,
        autoFixed: true,
      });
      return;
    }

    kept.push(q);
  });

  const verificationStatus: BlindVerificationResult["verificationStatus"] =
    droppedCount === 0 ? "verified" : "partial";

  return { questions: kept, warnings, droppedCount, verificationStatus };
}

function applyDeterministicIntegrityGuards(questions: QuizResult["questions"]): QuizResult["questions"] {
  return questions.map((q, idx) => {
    const normalizedStem = q.stem.trim();
    const normalizedCorrect = q.correct_answer.trim();
    const normalizedExplanation = q.explanation.trim() || "See worked method for the correct option.";
    const guardedOptions = dedupeOptions(q.options, normalizedCorrect);
    const marks = Number.isInteger(q.marks) ? Math.min(10, Math.max(1, q.marks)) : 1;
    const cleaned = {
      ...q,
      stem: normalizedStem || `Question ${idx + 1}`,
      options: guardedOptions,
      correct_answer: normalizedCorrect || guardedOptions[0],
      explanation: normalizedExplanation,
      marks,
    };
    return guardedOptions.includes(cleaned.correct_answer)
      ? cleaned
      : { ...cleaned, correct_answer: guardedOptions[0] };
  });
}

function decodePdfLiteral(segment: string): string {
  return segment
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\d{3}/g, " ");
}

function skipPdfWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code !== 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) break;
    index++;
  }
  return index;
}

function readPdfLiteral(input: string, start: number): { value: string; end: number } | null {
  if (input[start] !== "(") return null;

  let index = start + 1;
  let depth = 1;
  let escaped = false;
  let literal = "";

  while (index < input.length) {
    const char = input[index];
    if (escaped) {
      literal += `\\${char}`;
      escaped = false;
      index++;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      index++;
      continue;
    }

    if (char === "(") {
      depth++;
      literal += char;
      index++;
      continue;
    }

    if (char === ")") {
      depth--;
      if (depth === 0) {
        return { value: literal, end: index + 1 };
      }
      literal += char;
      index++;
      continue;
    }

    literal += char;
    index++;
  }

  return null;
}

function extractTextFromTjArray(input: string, start: number): { values: string[]; end: number } | null {
  if (input[start] !== "[") return null;

  const values: string[] = [];
  let index = start + 1;

  while (index < input.length) {
    index = skipPdfWhitespace(input, index);
    const char = input[index];

    if (!char) return null;
    if (char === "]") {
      return { values, end: index + 1 };
    }

    if (char === "(") {
      const literal = readPdfLiteral(input, index);
      if (!literal) return null;
      values.push(decodePdfLiteral(literal.value));
      index = literal.end;
      continue;
    }

    index++;
  }

  return null;
}

function extractTextOperators(pdfText: string): string[] {
  const chunks: string[] = [];
  let index = 0;

  while (index < pdfText.length) {
    const char = pdfText[index];

    if (char === "(") {
      const literal = readPdfLiteral(pdfText, index);
      if (!literal) break;
      const next = skipPdfWhitespace(pdfText, literal.end);
      if (pdfText.startsWith("Tj", next)) {
        chunks.push(decodePdfLiteral(literal.value));
        index = next + 2;
        continue;
      }
      index = literal.end;
      continue;
    }

    if (char === "[") {
      const array = extractTextFromTjArray(pdfText, index);
      if (!array) break;
      const next = skipPdfWhitespace(pdfText, array.end);
      if (pdfText.startsWith("TJ", next)) {
        chunks.push(...array.values);
        index = next + 2;
        continue;
      }
      index = array.end;
      continue;
    }

    index++;
  }

  return chunks.map((chunk) => chunk.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export async function parsePdfTextFromBuffer(buffer: Buffer): Promise<string> {
  const latin1 = buffer.toString("latin1");
  const operatorText = extractTextOperators(latin1).join(" ").replace(/\s+/g, " ").trim();
  if (operatorText && operatorText.split(/\s+/).filter(Boolean).length >= 2) {
    return operatorText;
  }

  const fallback = latin1
    .replace(/[^\x20-\x7E\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!fallback || fallback.split(/\s+/).filter(Boolean).length < 2) {
    throw new Error("Unable to parse PDF text content");
  }
  return fallback;
}

export async function fetchPaperContext(paperCode: string): Promise<string> {
  const query = encodeURIComponent(`${paperCode} past paper mark scheme pdf`);
  const html = await fetch(`https://duckduckgo.com/html/?q=${query}`).then((r) => r.text());
  return `Web search snippets for ${paperCode}:\n${html.slice(0, 6000)}`;
}

/**
 * Validates and corrects MCQ questions so that correct_answer exactly matches one of the options.
 * Returns a new array with all questions corrected.
 */
export function validateAndCorrectMcqAnswers(
  questions: Array<{ stem: string; options: string[]; correct_answer: string; explanation: string; marks: number }>
): Array<{ stem: string; options: string[]; correct_answer: string; explanation: string; marks: number }> {
  return questions.map((q) => {
    if (q.options.includes(q.correct_answer)) {
      return q;
    }

    // Attempt 1: If correct_answer is a letter like "A", "B", "C", "D", map to options index
    const letterMatch = q.correct_answer.trim().match(/^([A-Da-d])\.?$/);
    if (letterMatch) {
      const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < q.options.length) {
        console.warn(`[MCQ_VALIDATION_FIXED] Corrected mismatched answer string: letter "${q.correct_answer}" -> "${q.options[idx]}"`);
        return { ...q, correct_answer: q.options[idx] };
      }
    }

    // Attempt 2: Find closest matching option using normalized comparison
    const normalized = q.correct_answer.trim().toLowerCase().replace(/\s+/g, " ");
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < q.options.length; i++) {
      const optNorm = q.options[i].trim().toLowerCase().replace(/\s+/g, " ");
      // Check containment or prefix match
      if (optNorm === normalized) {
        bestIdx = i;
        bestScore = Infinity;
        break;
      }
      if (optNorm.includes(normalized) || normalized.includes(optNorm)) {
        const score = Math.min(optNorm.length, normalized.length) / Math.max(optNorm.length, normalized.length);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }

    if (bestIdx >= 0 && bestScore > 0.5) {
      console.warn(`[MCQ_VALIDATION_FIXED] Corrected mismatched answer string: "${q.correct_answer}" -> "${q.options[bestIdx]}"`);
      return { ...q, correct_answer: q.options[bestIdx] };
    }

    // Fallback: assign first option as correct answer
    console.warn(`[MCQ_VALIDATION_FIXED] Corrected mismatched answer string: no close match for "${q.correct_answer}", defaulting to options[0] "${q.options[0]}"`);
    return { ...q, correct_answer: q.options[0] };
  });
}

/**
 * STAGE 2 — Dedicated Gemini 2.5 Flash formatting checker.
 * Audits LaTeX, currency, options, scope, accuracy. Auto-fixes what it can.
 * Reports both auto-fixed and unfixable issues as structured warnings.
 */
export async function runGeminiFormattingCheck(
  questions: QuizResult["questions"],
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; warnings: PipelineWarning[]; checkerOk: boolean; durationMs: number }> {
  const startTime = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || process.env.NODE_ENV === "test") {
    console.warn("[GEMINI_CHECKER] Skipped (test mode or no GEMINI_API_KEY).");
    return { questions, warnings: [], checkerOk: false, durationMs: 0 };
  }

  const systemPrompt = `You are SOMA Format Checker (Gemini 2.5 Flash). Your job is FORMATTING + STRUCTURAL audit, not deep content rewrite.

AUDIT every question for these issues, then AUTO-FIX what you can:
1. LATEX DELIMITERS — every math expression MUST be wrapped in $...$ (inline) or $$...$$ (display). Raw LaTeX commands like \\frac, \\sqrt, \\int, ^{...}, _{...} MUST live inside $ delimiters. If you find unwrapped math, wrap it and set autoFixed: true.
2. CURRENCY — bare $ before a number (e.g. "$9,000") will break math rendering. Convert to "9,000 dollars" or "USD 9,000". Set autoFixed: true if you fix it.
3. OPTIONS — exactly 4 distinct options. correct_answer MUST exactly match one option verbatim.
4. EXPLANATION — non-empty, must justify the correct answer.
5. SCOPE — questions must stay within subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.
6. ACCURACY — flag (don't rewrite) any answer that looks objectively wrong; set autoFixed: false so the polisher can re-derive.

REPORT every issue you found, whether you fixed it or not:
- autoFixed: true → you fixed it in the returned questions
- autoFixed: false → you couldn't fix safely; the user/polisher must intervene

questionIndex is 1-based. Be concise in the issue field (one sentence).

Return strict JSON matching the schema. NEVER drop or add questions — return exactly ${questions.length}.`;

  const userPrompt = `Audit and fix these ${questions.length} questions:\n${JSON.stringify({ questions }, null, 2)}`;

  try {
    const checkerSchema = zodToJsonSchema(GeminiCheckerResponseSchema, "GeminiCheckerResponse");
    const data = await callGoogle("gemini-2.5-flash", systemPrompt, userPrompt, checkerSchema);
    const parsed = GeminiCheckerResponseSchema.parse(JSON.parse(data));
    if (parsed.questions.length !== questions.length) {
      console.warn(`[GEMINI_CHECKER] Question count drift: input=${questions.length}, output=${parsed.questions.length}. Keeping output.`);
    }
    console.log(`[GEMINI_CHECKER] Audited ${parsed.questions.length} questions, ${parsed.warnings.length} warnings (${parsed.warnings.filter((w) => w.autoFixed).length} auto-fixed).`);
    return { questions: parsed.questions, warnings: parsed.warnings, checkerOk: true, durationMs: Date.now() - startTime };
  } catch (error: any) {
    console.warn(`[GEMINI_CHECKER] Failed; pipeline continues without formatting audit. Reason: ${error?.message || "unknown"}`);
    // checkerOk=false ⇒ callers MUST NOT trigger Claude polish (nothing to polish against).
    // We still surface a UI-visible warning so the tutor knows the audit was skipped.
    return {
      questions,
      warnings: [{
        questionIndex: 0,
        field: "overall",
        issue: `Format checker unavailable (${error?.message || "unknown error"}). Questions delivered without auto-fix.`,
        autoFixed: false,
      }],
      checkerOk: false,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * STAGE 3 — Conditional Claude Sonnet polisher.
 * Only runs when Gemini surfaced warnings. Polishes wording, resolves any
 * unfixed issues, and re-derives flagged answers.
 */
export async function runClaudePolish(
  questions: QuizResult["questions"],
  warnings: PipelineWarning[],
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; durationMs: number }> {
  const startTime = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || warnings.length === 0 || process.env.NODE_ENV === "test") {
    return { questions, durationMs: 0 };
  }

  const issuesSummary = warnings
    .map((w) => `Q${w.questionIndex} [${w.field}] ${w.issue}${w.autoFixed ? " (auto-fixed by checker)" : " (UNFIXED — needs your attention)"}`)
    .join("\n");

  const systemPrompt = `You are Claude Polisher (claude-sonnet-4-6), the final wording and clarity gate.

The Gemini checker flagged these issues:
${issuesSummary}

Your job:
1. Polish wording for pedagogical clarity and tone.
2. Resolve every UNFIXED issue (re-derive answers, rewrite ambiguous stems, replace weak distractors).
3. Re-verify auto-fixed issues — confirm Gemini's fix is sound.
4. Preserve question intent, difficulty, and topic coverage.
5. Keep exactly the same number of questions.
6. correct_answer MUST exactly match one of the 4 options.

Subject=${context.subject}; syllabus=${context.syllabus}; level=${context.level}; topic=${context.topic}${context.subtopic ? `; subtopic=${context.subtopic}` : ""}.

Return strict JSON matching the schema.`;

  try {
    const anthropic = new Anthropic({ apiKey });
    // Anthropic requires `type` at the root of input_schema; unwrap the Zod wrapper.
    const wrapped: any = zodToJsonSchema(QuizResultSchema, "QuizResult");
    const inner: any = wrapped?.definitions?.QuizResult ?? zodToJsonSchema(QuizResultSchema);
    const inputSchema: any = { ...inner, type: inner?.type || "object" };
    delete inputSchema.$schema;
    delete inputSchema.$ref;
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16_384,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: `Polish these questions:\n${JSON.stringify({ questions })}` }],
      tools: [{
        name: "return_polished_quiz",
        description: "Return polished quiz JSON.",
        input_schema: inputSchema,
      }],
      tool_choice: { type: "tool", name: "return_polished_quiz" },
    });
    const toolBlock = response.content.find((b: any) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") throw new Error("Polisher returned no tool output");
    const parsed = QuizResultSchema.parse(toolBlock.input);
    console.log(`[CLAUDE_POLISH] Polished ${parsed.questions.length} questions in ${Date.now() - startTime}ms.`);
    return { questions: parsed.questions, durationMs: Date.now() - startTime };
  } catch (error: any) {
    console.warn(`[CLAUDE_POLISH] Failed; keeping checker output. Reason: ${error?.message || "unknown"}`);
    return { questions, durationMs: Date.now() - startTime };
  }
}

async function runClaudeMaker(
  context: SomaGenerationContext,
  questionCount: number,
  distribution: { easy: number; medium: number; hard: number },
): Promise<{ result: QuizResult; model: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const anthropic = new Anthropic({ apiKey });
  const wrapped: any = zodToJsonSchema(QuizResultSchema, "QuizResult");
  const inner: any = wrapped?.definitions?.QuizResult ?? zodToJsonSchema(QuizResultSchema);
  const inputSchema: any = { ...inner, type: inner?.type || "object" };
  delete inputSchema.$schema;
  delete inputSchema.$ref;

  const systemPrompt = `You are Claude, the sole question MAKER for SOMA.
Generate exactly ${questionCount} MCQ questions and strong distractors.
STRICT SCOPE: subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.
Difficulty mix target: easy=${distribution.easy}%, medium=${distribution.medium}%, hard=${distribution.hard}%.

Distractor rules (mandatory):
- 4 distinct options exactly.
- Distractors must be plausible but clearly wrong under syllabus rules.
- Avoid duplicate/near-duplicate options.
- Avoid “all of the above” / “none of the above” unless explicitly requested.

Formatting rules (mandatory):
- Wrap all mathematical notation in LaTeX delimiters ($...$ or $$...$$).
- Never use a bare $ before currency values; write "USD 9,000" or "9,000 dollars".
- explanation must justify the correct answer and briefly reject key distractors.
- correct_answer must exactly match one option.`;

  const userPrompt = `Generate the quiz with this grounding context:\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16_384,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [{
      name: "return_quiz",
      description: "Return quiz JSON matching schema.",
      input_schema: inputSchema,
    }],
    tool_choice: { type: "tool", name: "return_quiz" },
  });

  const toolBlock = response.content.find((b: any) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Claude maker returned no tool output");
  }
  return { result: QuizResultSchema.parse(toolBlock.input), model: "anthropic/claude-sonnet-4-6" };
}

async function runEmergencySingleStageGeneration(
  context: SomaGenerationContext,
  questionCount: number,
): Promise<{ result: QuizResult; model: string }> {
  const emergencyPrompt = `You are an emergency assessment generation fallback.
Return strictly valid JSON with exactly ${questionCount} high-quality MCQ questions.
Subject=${context.subject}; syllabus=${context.syllabus}; level=${context.level}; topic=${context.topic}${context.subtopic ? `; subtopic=${context.subtopic}` : ""}.

Critical requirements:
1) Every question must be objectively correct.
2) Exactly 4 distinct options per question.
3) correct_answer must exactly match one option.
4) explanation must justify why the correct answer is correct.
5) Keep questions within provided syllabus/topic scope only.
6) Return JSON only matching the schema.`;

  const { data, metadata } = await generateWithFallback(
    emergencyPrompt,
    `Curriculum context:\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`,
    jsonSchema,
  );
  return { result: extractJson(data), model: `${metadata.provider}/${metadata.model}` };
}

/**
 * Pipeline (strict blind dual-verify):
 *   1. MAKER           — Claude drafts questions + distractors
 *   2. SCOPE + GUARDS  — filter to topic; run deterministic integrity guards
 *   3. BLIND VERIFY    — Claude + Gemini solve from stem only (no options shown);
 *                        questions where both verifiers agree on the maker's answer
 *                        are kept; where both agree on a DIFFERENT option, we
 *                        override; anything else is DROPPED, not shipped.
 *   4. CAS VALIDATOR   — Deterministic math validator can still override LLMs
 *                        on verifiable arithmetic questions.
 *   5. FINAL GUARDS    — integrity guards + MCQ repair, then hard-gate (throw if empty).
 *
 * Returns questions + warnings (for Co-Pilot UI) + telemetry (for cost tracking).
 */
export async function generateAuditedQuiz(input: SomaGenerationContext | string): Promise<AuditedQuizResult> {
  const overallStart = Date.now();
  const context: SomaGenerationContext = typeof input === "string"
    ? { topic: input, subject: "Mathematics", syllabus: "IEB", level: "Grade 6-12" }
    : input;

  const questionCount = Math.max(1, Math.min(50, context.questionCount ?? 8));

  // Batch large quizzes — recurse with smaller counts and merge
  if (questionCount > 20) {
    const batchSize = 15;
    const merged: QuizResult["questions"] = [];
    const allWarnings: PipelineWarning[] = [];
    let lastTelemetry: PipelineTelemetry = {
      makerModel: "unknown",
      checkerModel: "anthropic/claude-sonnet-4-6 + google/gemini-2.5-flash (blind)",
      polishModel: null,
      totalDurationMs: 0,
    };
    let remaining = questionCount;
    while (remaining > 0) {
      const currentBatch = Math.min(batchSize, remaining);
      const baseIndex = merged.length;
      const batchResult = await generateAuditedQuiz({ ...context, questionCount: currentBatch });
      merged.push(...batchResult.questions);
      for (const w of batchResult.warnings) {
        allWarnings.push({ ...w, questionIndex: w.questionIndex + baseIndex });
      }
      lastTelemetry = batchResult.telemetry;
      remaining -= currentBatch;
    }
    return {
      questions: validateAndCorrectMcqAnswers(merged.slice(0, questionCount)),
      warnings: allWarnings,
      telemetry: { ...lastTelemetry, totalDurationMs: Date.now() - overallStart },
    };
  }

  const distribution = context.difficultyDistribution ?? { easy: 25, medium: 50, hard: 25 };

  let parsed: QuizResult;
  let makerModel = "unknown";
  try {
    const makerResult = await runClaudeMaker(context, questionCount, distribution);
    parsed = makerResult.result;
    makerModel = makerResult.model;
  } catch (error: any) {
    if (process.env.NODE_ENV === "test") throw error;
    console.warn(`[SOMA_PIPELINE] Claude maker failed, attempting emergency fallback. Reason: ${error?.message || "unknown"}`);
    const emergency = await runEmergencySingleStageGeneration(context, questionCount);
    parsed = emergency.result;
    makerModel = `emergency:${emergency.model}`;
  }

  // Scope filter
  const scopeTokens = [context.topic, context.subtopic].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  if (scopeTokens.length > 0) {
    const scoped = parsed.questions.filter((q) => {
      const hay = `${q.stem} ${q.explanation} ${q.topic_tag || ""} ${q.subtopic_tag || ""}`.toLowerCase();
      return scopeTokens.some((token) => hay.includes(token));
    });
    if (scoped.length > 0) parsed.questions = scoped;
  }
  if (parsed.questions.length < questionCount && parsed.questions.length > 0) {
    console.warn(`[SOMA_PIPELINE] Only ${parsed.questions.length}/${questionCount} questions strongly matched topic scope; keeping best set.`);
  }
  parsed.questions = parsed.questions.slice(0, questionCount);
  parsed.questions = applyDeterministicIntegrityGuards(parsed.questions);
  parsed.questions = validateAndCorrectMcqAnswers(parsed.questions);

  // ── BLIND DUAL-VERIFY ────────────────────────────────────────────
  // Claude and Gemini each solve the stem (no options visible). Questions
  // survive only if both verifiers agree on a single option; we override
  // the maker when both land on a different option; anything else is
  // DROPPED so we never ship an unverified answer.
  const warnings: PipelineWarning[] = [];
  const verify = await verifyQuestionsBlind(parsed.questions, context);
  parsed.questions = verify.questions;
  warnings.push(...verify.warnings);
  if (verify.verificationStatus === "failed") {
    warnings.push({
      questionIndex: 0,
      field: "overall",
      issue: "Blind verification could not run — all non-math questions were dropped to protect answer integrity.",
      autoFixed: false,
    });
  }

  // ── DETERMINISTIC MATH VALIDATION ────────────────────────────────
  // For verifiable maths questions (function evaluation, arithmetic) we re-derive
  // the answer with a CAS and OVERRIDE the LLM if it disagrees.
  parsed.questions = parsed.questions.map((q, idx) => {
    const v = validateMathQuestion(q.stem, q.options, q.correct_answer);
    if (!v.verifiable || !v.matchedOption) return q;
    if (v.mismatch) {
      warnings.push({
        questionIndex: idx + 1,
        field: "correct_answer",
        issue: `Math validator overrode AI answer "${q.correct_answer}" with deterministic result "${v.matchedOption}" (computed = ${v.computedAnswer}).`,
        autoFixed: true,
      });
      const newExplanation = v.workedSolution
        ? v.workedSolution
        : `Deterministic math validation confirms the correct option is "${v.matchedOption}" (computed value: ${v.computedAnswer}).`;
      return { ...q, correct_answer: v.matchedOption, explanation: newExplanation };
    }
    return q;
  });

  // Final deterministic guards (cheap, free)
  parsed.questions = applyDeterministicIntegrityGuards(parsed.questions);
  parsed.questions = validateAndCorrectMcqAnswers(parsed.questions);

  // Hard gate — never return an empty quiz silently.
  if (parsed.questions.length === 0) {
    throw new Error("Quiz generation failed: no questions survived blind dual-verification. Try again or adjust the topic.");
  }

  return {
    questions: parsed.questions,
    warnings,
    telemetry: {
      makerModel,
      checkerModel: "anthropic/claude-sonnet-4-6 + google/gemini-2.5-flash (blind)",
      polishModel: null,
      totalDurationMs: Date.now() - overallStart,
    },
  };
}
