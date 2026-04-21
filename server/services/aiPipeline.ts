import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { callGoogle } from "./aiOrchestrator";
import {
  formatCopilotContextAsText,
  type CatalogueCopilotContext,
} from "./copilotContext";
import { validateMathQuestion } from "./mathValidator";

// ─── Schemas ────────────────────────────────────────────────────────────────

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

// Maker produces a DRAFT without the explanation — the verifier writes the
// Soma tutor explanation AFTER the answer is confirmed correct, so we never
// spend tokens on explanations that would be thrown away if the answer changes.
const DraftQuestionSchema = z.object({
  stem: z.string(),
  options: z.array(z.string()).length(4),
  correct_answer: z.string(),
  marks: z.number().int().min(1).max(10),
  difficulty_tag: z.enum(["easy", "medium", "hard"]).optional(),
  topic_tag: z.string().optional(),
  subtopic_tag: z.string().optional(),
});

const DraftQuizSchema = z.object({
  questions: z.array(DraftQuestionSchema).min(1),
});

type DraftQuiz = z.infer<typeof DraftQuizSchema>;

const VerifierResponseSchema = z.object({
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
  catalogueContext?: CatalogueCopilotContext;
}

// ─── Soma tutor voice ───────────────────────────────────────────────────────

const SOMA_TUTOR_VOICE = `Write each explanation in the Soma tutor voice: encouraging but objective.
- Affirm the correct reasoning directly. No flattery, no emotive filler.
- State clearly WHY the correct answer is correct using syllabus-level reasoning.
- Briefly note why the most plausible distractor is wrong.
- Use precise educator phrasing. 2-4 sentences per explanation.`;

// ─── Deterministic helpers ──────────────────────────────────────────────────

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

/**
 * Snap correct_answer onto one of the options verbatim. If the maker returned
 * a letter ("A"/"B"), an answer with extra punctuation, or a paraphrase, we
 * try letter-mapping, then substring-matching, then fall back to options[0].
 */
export function validateAndCorrectMcqAnswers(
  questions: Array<{ stem: string; options: string[]; correct_answer: string; explanation: string; marks: number }>,
): Array<{ stem: string; options: string[]; correct_answer: string; explanation: string; marks: number }> {
  return questions.map((q) => {
    if (q.options.includes(q.correct_answer)) return q;

    const letterMatch = q.correct_answer.trim().match(/^([A-Da-d])\.?$/);
    if (letterMatch) {
      const idx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < q.options.length) {
        return { ...q, correct_answer: q.options[idx] };
      }
    }

    const normalized = q.correct_answer.trim().toLowerCase().replace(/\s+/g, " ");
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < q.options.length; i++) {
      const optNorm = q.options[i].trim().toLowerCase().replace(/\s+/g, " ");
      if (optNorm === normalized) return { ...q, correct_answer: q.options[i] };
      if (optNorm.includes(normalized) || normalized.includes(optNorm)) {
        const score = Math.min(optNorm.length, normalized.length) / Math.max(optNorm.length, normalized.length);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0 && bestScore > 0.5) return { ...q, correct_answer: q.options[bestIdx] };
    return { ...q, correct_answer: q.options[0] };
  });
}

/**
 * Deterministic math check: for numeric-answer questions we can solve on the
 * server, verify the stored correct_answer matches; if not, snap it to the
 * correct option and emit a warning so the UI can flag the auto-fix.
 */
function applyMathValidatorCorrections(
  questions: QuizResult["questions"],
): { questions: QuizResult["questions"]; warnings: PipelineWarning[] } {
  const warnings: PipelineWarning[] = [];
  const corrected = questions.map((q, idx) => {
    const result = validateMathQuestion(q.stem, q.options, q.correct_answer);
    if (!result.verifiable || !result.matchedOption) return q;
    if (result.storedCorrectMatches) return q;
    warnings.push({
      questionIndex: idx + 1,
      field: "correct_answer",
      issue: `Deterministic math check overrode answer "${q.correct_answer}" → "${result.matchedOption}" (pattern: ${result.pattern}).`,
      autoFixed: true,
    });
    return { ...q, correct_answer: result.matchedOption };
  });
  return { questions: corrected, warnings };
}

// ─── Catalogue context helpers ─────────────────────────────────────────────

function catalogueBlock(context: SomaGenerationContext, prefix = "\n\n"): string {
  if (!context.catalogueContext) return "";
  return `${prefix}Catalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}`;
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function buildMakerSystemPrompt(
  context: SomaGenerationContext,
  questionCount: number,
  distribution: { easy: number; medium: number; hard: number },
): string {
  return `You are the SOMA question maker. Generate exactly ${questionCount} MCQ questions.

STRICT SCOPE: subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.
Difficulty mix target: easy=${distribution.easy}%, medium=${distribution.medium}%, hard=${distribution.hard}%.

Requirements:
- Exactly 4 distinct options per question.
- correct_answer MUST match exactly one option verbatim.
- Distractors must be plausible but clearly wrong under syllabus rules.
- Avoid "all of the above" / "none of the above" unless explicitly requested.
- Wrap math in LaTeX delimiters ($...$ inline, $$...$$ display).
- Never use a bare $ before currency; write "USD 9,000" or "9,000 dollars".
- Do NOT write the explanation field — the verifier writes it after confirming the answer.`;
}

function buildMakerUserPrompt(context: SomaGenerationContext): string {
  return `Topic: ${context.topic}${catalogueBlock(context)}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`;
}

function buildVerifierSystemPrompt(context: SomaGenerationContext): string {
  return `You are the SOMA question verifier. For EACH question you receive:

1. CHECK that correct_answer is objectively correct and in-scope for subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}. The 4 options must be distinct and the question solvable.
2. FIX any error you find:
   - If correct_answer is wrong but a correct option exists, change correct_answer to that option.
   - If no option is correct, rewrite one option so it is correct and set correct_answer to it.
   - If the stem is ambiguous or unsolvable, rewrite the stem minimally to make a clear, correct question.
3. Once the answer is correct, WRITE the explanation field in this voice:

${SOMA_TUTOR_VOICE}

Return the FULL corrected question set — same count, same order. For every fix add a warning entry with autoFixed=true. Never drop or add questions.`;
}

function buildVerifierUserPrompt(
  questions: DraftQuiz["questions"],
  context: SomaGenerationContext,
): string {
  return `${catalogueBlock(context, "")}${context.catalogueContext ? "\n\n" : ""}Verify, fix, and explain these ${questions.length} questions:\n${JSON.stringify({ questions }, null, 2)}`;
}

// ─── Pipeline stages ────────────────────────────────────────────────────────

export async function runClaudeMakerSimple(
  context: SomaGenerationContext,
  questionCount: number,
  distribution: { easy: number; medium: number; hard: number },
): Promise<DraftQuiz> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const anthropic = new Anthropic({ apiKey });
  const wrapped: any = zodToJsonSchema(DraftQuizSchema, "DraftQuiz");
  const inner: any = wrapped?.definitions?.DraftQuiz ?? zodToJsonSchema(DraftQuizSchema);
  const inputSchema: any = { ...inner, type: inner?.type || "object" };
  delete inputSchema.$schema;
  delete inputSchema.$ref;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16_384,
    temperature: 0,
    system: buildMakerSystemPrompt(context, questionCount, distribution),
    messages: [{ role: "user", content: buildMakerUserPrompt(context) }],
    tools: [{
      name: "return_quiz_draft",
      description: "Return draft quiz JSON (no explanations).",
      input_schema: inputSchema,
    }],
    tool_choice: { type: "tool", name: "return_quiz_draft" },
  });

  const toolBlock = response.content.find((b: any) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Claude maker returned no tool output");
  }
  return DraftQuizSchema.parse(toolBlock.input);
}

export async function runOpenAIMakerSimple(
  context: SomaGenerationContext,
  questionCount: number,
  distribution: { easy: number; medium: number; hard: number },
): Promise<DraftQuiz> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildMakerSystemPrompt(context, questionCount, distribution) },
      {
        role: "user",
        content: `${buildMakerUserPrompt(context)}\n\nReturn JSON with shape: { "questions": [{stem, options[4], correct_answer, marks, difficulty_tag?, topic_tag?, subtopic_tag?}, ...] }`,
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "";
  return DraftQuizSchema.parse(JSON.parse(raw));
}

export async function runOpenAIVerifier(
  draftQuestions: DraftQuiz["questions"],
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; warnings: PipelineWarning[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const schema = zodToJsonSchema(VerifierResponseSchema, "VerifierResponse");
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildVerifierSystemPrompt(context) },
      {
        role: "user",
        content: `${buildVerifierUserPrompt(draftQuestions, context)}\n\nReturn JSON matching this schema only:\n${JSON.stringify(schema)}`,
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "";
  const parsed = VerifierResponseSchema.parse(JSON.parse(raw));
  return { questions: parsed.questions, warnings: parsed.warnings };
}

export async function runGeminiVerifier(
  draftQuestions: DraftQuiz["questions"],
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; warnings: PipelineWarning[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const schema = zodToJsonSchema(VerifierResponseSchema, "VerifierResponse");
  const raw = await callGoogle(
    "gemini-2.5-flash",
    buildVerifierSystemPrompt(context),
    buildVerifierUserPrompt(draftQuestions, context),
    schema,
  );
  const parsed = VerifierResponseSchema.parse(JSON.parse(raw));
  return { questions: parsed.questions, warnings: parsed.warnings };
}

// Mutable indirection so tests can swap stages without module-level mocks.
export const pipelineStages = {
  runClaudeMakerSimple,
  runOpenAIMakerSimple,
  runOpenAIVerifier,
  runGeminiVerifier,
};

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Pipeline:
 *   1. MAKER — Claude drafts the questions; if Claude fails, ChatGPT takes over.
 *   2. VERIFIER — ChatGPT checks each question. If the answer is wrong or missing,
 *      ChatGPT fixes it; then it writes the Soma tutor explanation.
 *      If Claude was the maker and ChatGPT verifier fails, Gemini takes over.
 *      If ChatGPT was the maker (because Claude failed), Gemini verifies —
 *      never let the same model both write and grade itself.
 *   3. Deterministic guards — dedupe options, clamp marks, snap correct_answer
 *      to a real option, and re-verify numeric answers with the math validator.
 */
export async function generateAuditedQuiz(input: SomaGenerationContext | string): Promise<AuditedQuizResult> {
  const overallStart = Date.now();
  const context: SomaGenerationContext = typeof input === "string"
    ? { topic: input, subject: "Mathematics", syllabus: "IEB", level: "Grade 6-12" }
    : input;

  const questionCount = Math.max(1, Math.min(50, context.questionCount ?? 8));
  const distribution = context.difficultyDistribution ?? { easy: 25, medium: 50, hard: 25 };

  // Batch quizzes > 15 into chunks of 15 so each stage stays within token budget.
  if (questionCount > 15) {
    const merged: QuizResult["questions"] = [];
    const allWarnings: PipelineWarning[] = [];
    let lastTelemetry: PipelineTelemetry = {
      makerModel: "unknown", checkerModel: "unknown", polishModel: null, totalDurationMs: 0,
    };
    let remaining = questionCount;
    while (remaining > 0) {
      const currentBatch = Math.min(15, remaining);
      const baseIndex = merged.length;
      const batch = await generateAuditedQuiz({ ...context, questionCount: currentBatch });
      merged.push(...batch.questions);
      for (const w of batch.warnings) {
        allWarnings.push({ ...w, questionIndex: w.questionIndex + baseIndex });
      }
      lastTelemetry = batch.telemetry;
      remaining -= currentBatch;
    }
    return {
      questions: validateAndCorrectMcqAnswers(merged.slice(0, questionCount)),
      warnings: allWarnings,
      telemetry: { ...lastTelemetry, totalDurationMs: Date.now() - overallStart },
    };
  }

  // ── STAGE 1: MAKER ──────────────────────────────────────────────────────
  let draft: DraftQuiz;
  let makerModel: string;
  let claudeMadeTheQuiz = true;
  try {
    draft = await pipelineStages.runClaudeMakerSimple(context, questionCount, distribution);
    makerModel = "anthropic/claude-sonnet-4-6";
  } catch (err: any) {
    console.warn(`[SOMA_PIPELINE] Claude maker failed (${err?.message || "unknown"}); falling back to ChatGPT maker.`);
    draft = await pipelineStages.runOpenAIMakerSimple(context, questionCount, distribution);
    makerModel = "openai/gpt-4o";
    claudeMadeTheQuiz = false;
  }

  // ── STAGE 2: VERIFIER (checker + Soma tutor voice) ──────────────────────
  // Pairing rule: the model that made the quiz must not verify its own work.
  //   Claude maker → ChatGPT verifier (Gemini as fallback for availability).
  //   ChatGPT maker → Gemini verifier only (no self-check).
  let verified: { questions: QuizResult["questions"]; warnings: PipelineWarning[] };
  let checkerModel: string;
  if (claudeMadeTheQuiz) {
    try {
      verified = await pipelineStages.runOpenAIVerifier(draft.questions, context);
      checkerModel = "openai/gpt-4o";
    } catch (err: any) {
      console.warn(`[SOMA_PIPELINE] ChatGPT verifier failed (${err?.message || "unknown"}); falling back to Gemini verifier.`);
      verified = await pipelineStages.runGeminiVerifier(draft.questions, context);
      checkerModel = "google/gemini-2.5-flash";
    }
  } else {
    verified = await pipelineStages.runGeminiVerifier(draft.questions, context);
    checkerModel = "google/gemini-2.5-flash";
  }

  // ── STAGE 3: Deterministic guards ───────────────────────────────────────
  let finalQuestions = validateAndCorrectMcqAnswers(applyDeterministicIntegrityGuards(verified.questions));
  const mathCheck = applyMathValidatorCorrections(finalQuestions);
  finalQuestions = mathCheck.questions;

  return {
    questions: finalQuestions,
    warnings: [...verified.warnings, ...mathCheck.warnings],
    telemetry: {
      makerModel,
      checkerModel,
      polishModel: null,
      totalDurationMs: Date.now() - overallStart,
    },
  };
}

/**
 * Audit an already-drafted question set (used by the tutor Copilot chat flow
 * which produces draft MCQs outside the main pipeline). Runs the same
 * ChatGPT → Gemini verifier fallback so the Soma voice and answer-fix logic
 * stay consistent across entry points.
 */
export async function runQuestionAudit(
  questions: Array<{
    stem: string;
    options: string[];
    correct_answer: string;
    explanation?: string;
    marks: number;
    difficulty_tag?: "easy" | "medium" | "hard";
    topic_tag?: string;
    subtopic_tag?: string;
  }>,
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; warnings: PipelineWarning[]; verifierModel: string | null }> {
  if (questions.length === 0) {
    return { questions: [], warnings: [], verifierModel: null };
  }
  const draftQuestions: DraftQuiz["questions"] = questions.map((q) => ({
    stem: q.stem,
    options: q.options,
    correct_answer: q.correct_answer,
    marks: q.marks,
    difficulty_tag: q.difficulty_tag,
    topic_tag: q.topic_tag,
    subtopic_tag: q.subtopic_tag,
  }));

  try {
    const verified = await pipelineStages.runOpenAIVerifier(draftQuestions, context);
    const guarded = validateAndCorrectMcqAnswers(applyDeterministicIntegrityGuards(verified.questions));
    const mathCheck = applyMathValidatorCorrections(guarded);
    return {
      questions: mathCheck.questions,
      warnings: [...verified.warnings, ...mathCheck.warnings],
      verifierModel: "openai/gpt-4o",
    };
  } catch (err: any) {
    console.warn(`[COPILOT_AUDIT] ChatGPT verifier failed (${err?.message || "unknown"}); falling back to Gemini.`);
    try {
      const verified = await pipelineStages.runGeminiVerifier(draftQuestions, context);
      const guarded = validateAndCorrectMcqAnswers(applyDeterministicIntegrityGuards(verified.questions));
      const mathCheck = applyMathValidatorCorrections(guarded);
      return {
        questions: mathCheck.questions,
        warnings: [...verified.warnings, ...mathCheck.warnings],
        verifierModel: "google/gemini-2.5-flash",
      };
    } catch (err2: any) {
      console.warn(`[COPILOT_AUDIT] Gemini verifier also failed (${err2?.message || "unknown"}); returning unaudited drafts.`);
      return {
        questions: questions.map((q) => ({
          ...q,
          explanation: q.explanation || "Explanation unavailable — verifier could not run.",
        })),
        warnings: [{
          questionIndex: 0,
          field: "overall",
          issue: `Verifier unavailable (${err2?.message || err?.message || "unknown"}). Questions returned unaudited.`,
          autoFixed: false,
        }],
        verifierModel: null,
      };
    }
  }
}

// ─── PDF utilities (unchanged — used by curriculum ingestion & PDF uploads) ─

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
      if (depth === 0) return { value: literal, end: index + 1 };
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
    if (char === "]") return { values, end: index + 1 };
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

// ─── Legacy export kept for reconcileCheckerStems test ──────────────────────
// Phase 8's stem-drift guard is no longer wired into the pipeline (the
// dual-checker/polish stage it protected has been removed), but the helper
// has its own tests and may still be useful for ad-hoc checker comparisons.

function normaliseStemForDriftCheck(stem: string): string {
  return stem
    .replace(/\$+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function reconcileCheckerStems(
  makerQuestions: QuizResult["questions"],
  checkerQuestions: QuizResult["questions"],
  checkerWarnings: PipelineWarning[],
): { questions: QuizResult["questions"]; driftWarnings: PipelineWarning[] } {
  const driftWarnings: PipelineWarning[] = [];
  const stemWarningByIndex = new Set<number>();
  for (const w of checkerWarnings) {
    if (w.field === "stem") stemWarningByIndex.add(w.questionIndex);
  }
  const n = Math.min(makerQuestions.length, checkerQuestions.length);
  const out: QuizResult["questions"] = checkerQuestions.slice();
  for (let i = 0; i < n; i++) {
    const makerStem = makerQuestions[i].stem;
    const checkerStem = checkerQuestions[i].stem;
    if (normaliseStemForDriftCheck(makerStem) === normaliseStemForDriftCheck(checkerStem)) continue;
    if (stemWarningByIndex.has(i + 1)) continue;
    out[i] = { ...checkerQuestions[i], stem: makerStem };
    driftWarnings.push({
      questionIndex: i + 1,
      field: "stem",
      issue: "Formatting checker rewrote the stem without flagging it; reverted to Maker original.",
      autoFixed: true,
    });
  }
  return { questions: out, driftWarnings };
}
