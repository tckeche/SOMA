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
import { recordCall, newRequestId } from "../utils/aiTelemetry";
import * as health from "./aiHealth";
import { clampMaxTokens } from "./aiCostGuards";
import { renderSeedsForPrompt } from "./examinerDistractorSeeds";
import { describePrompt, PromptIds } from "./aiPromptRegistry";
import { validateAgainstSchema } from "./aiContracts";

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
  /** Examiner-misconception ids the batch was seeded against (Phase 2B).
   *  Persist on each question's `target_misconception_ids` so the marker
   *  can cite the matched insight. */
  seedMisconceptionIds: number[];
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
  /**
   * Phase 2B — approved examiner-misconception seeds. When present, the
   * maker prompt asks for distractors based on these known student
   * errors. The ids are persisted as `target_misconception_ids` on every
   * question in this batch so the marker can attribute wrong answers to
   * specific misconceptions.
   */
  examinerSeeds?: import("./examinerDistractorSeeds").ExaminerSeed[];
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

function applyDeterministicIntegrityGuards(
  questions: QuizResult["questions"],
): { questions: QuizResult["questions"]; warnings: PipelineWarning[] } {
  const warnings: PipelineWarning[] = [];
  const corrected = questions.map((q, idx) => {
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
    if (guardedOptions.includes(cleaned.correct_answer)) return cleaned;
    warnings.push({
      questionIndex: idx + 1,
      field: "correct_answer",
      issue: `Stored correct_answer "${cleaned.correct_answer}" did not survive option dedupe/normalisation; defaulted to "${guardedOptions[0]}". Verify the answer key manually.`,
      autoFixed: false,
    });
    return { ...cleaned, correct_answer: guardedOptions[0] };
  });
  return { questions: corrected, warnings };
}

/**
 * Snap correct_answer onto one of the options verbatim. If the maker returned
 * a letter ("A"/"B"), an answer with extra punctuation, or a paraphrase, we
 * try letter-mapping, then substring-matching. If nothing matches we still
 * fall back to options[0] to keep the quiz savable, but emit a CRITICAL
 * warning so the tutor must review the question before publishing — silent
 * fallback is what was previously corrupting answer keys.
 */
export function validateAndCorrectMcqAnswers(
  questions: Array<{ stem: string; options: string[]; correct_answer: string; explanation: string; marks: number }>,
): {
  questions: Array<{ stem: string; options: string[]; correct_answer: string; explanation: string; marks: number }>;
  warnings: PipelineWarning[];
} {
  const warnings: PipelineWarning[] = [];
  const corrected = questions.map((q, idx) => {
    if (q.options.includes(q.correct_answer)) return q;

    const letterMatch = q.correct_answer.trim().match(/^([A-Da-d])\.?$/);
    if (letterMatch) {
      const letterIdx = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
      if (letterIdx >= 0 && letterIdx < q.options.length) {
        warnings.push({
          questionIndex: idx + 1,
          field: "correct_answer",
          issue: `Verifier returned bare letter "${q.correct_answer}" instead of the option text; mapped to "${q.options[letterIdx]}".`,
          autoFixed: true,
        });
        return { ...q, correct_answer: q.options[letterIdx] };
      }
    }

    const normalized = q.correct_answer.trim().toLowerCase().replace(/\s+/g, " ");
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < q.options.length; i++) {
      const optNorm = q.options[i].trim().toLowerCase().replace(/\s+/g, " ");
      if (optNorm === normalized) {
        warnings.push({
          questionIndex: idx + 1,
          field: "correct_answer",
          issue: `Verifier's correct_answer differed only in whitespace/case from option "${q.options[i]}"; auto-normalised.`,
          autoFixed: true,
        });
        return { ...q, correct_answer: q.options[i] };
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
      warnings.push({
        questionIndex: idx + 1,
        field: "correct_answer",
        issue: `Verifier's correct_answer "${q.correct_answer}" only partially matched option "${q.options[bestIdx]}" (${(bestScore * 100).toFixed(0)}% similarity); auto-snapped. Please verify before publishing.`,
        autoFixed: true,
      });
      return { ...q, correct_answer: q.options[bestIdx] };
    }
    warnings.push({
      questionIndex: idx + 1,
      field: "correct_answer",
      issue: `CRITICAL: verifier's correct_answer "${q.correct_answer}" does not match ANY of the 4 options. Defaulted to "${q.options[0]}" so the quiz is savable, but the answer key is unverifiable — REVIEW THIS QUESTION MANUALLY before publishing or students may be marked wrong on the right answer.`,
      autoFixed: false,
    });
    return { ...q, correct_answer: q.options[0] };
  });
  return { questions: corrected, warnings };
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
  const seedsBlock = context.examinerSeeds && context.examinerSeeds.length > 0
    ? "\n\n" + renderSeedsForPrompt(context.examinerSeeds)
    : "";
  return `Topic: ${context.topic}${catalogueBlock(context)}${seedsBlock}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`;
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

/**
 * Instrument a direct provider call: tracks health, emits a telemetry record,
 * and runs the optional schema gate. Throws on failure so the caller's
 * existing try/catch fallback logic runs unchanged.
 */
async function instrumentedCall<T>(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  promptId: string,
  taskType: string,
  parentRequestId: string,
  run: () => Promise<{ raw: string; parsed: T }>,
): Promise<T> {
  const startedAt = Date.now();
  const requestId = newRequestId();
  const descriptor = describePrompt(promptId);
  try {
    const { raw, parsed } = await run();
    const endedAt = Date.now();
    health.recordSuccess(provider, model, endedAt - startedAt);
    recordCall({
      requestId,
      parentRequestId,
      provider,
      model,
      taskType,
      promptVersion: descriptor?.version,
      systemPrompt,
      userPrompt,
      startedAt,
      endedAt,
      rawResponse: raw,
      parse: { status: "success" },
      validation: { status: "pass" },
    });
    return parsed;
  } catch (err: any) {
    const endedAt = Date.now();
    const message = err?.message || String(err);
    const timedOut = /timed out/i.test(message);
    const validationFail = /schema gate failed/i.test(message);
    const failureKind: "timeout" | "validation" | "other" = timedOut ? "timeout" : validationFail ? "validation" : "other";
    health.recordFailure(provider, model, failureKind);
    recordCall({
      requestId,
      parentRequestId,
      provider,
      model,
      taskType,
      promptVersion: descriptor?.version,
      systemPrompt,
      userPrompt,
      startedAt,
      endedAt,
      timedOut,
      parse: { status: "failure", error: message },
      validation: { status: "fail", reason: message },
      error: message,
    });
    throw err;
  }
}

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

  const systemPrompt = buildMakerSystemPrompt(context, questionCount, distribution);
  const userPrompt = buildMakerUserPrompt(context);

  return instrumentedCall<DraftQuiz>(
    "anthropic",
    "claude-sonnet-4-6",
    systemPrompt,
    userPrompt,
    PromptIds.SOMA_MAKER,
    "generation",
    newRequestId(),
    async () => {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: clampMaxTokens(16_384, "generation"),
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
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
      const validated = validateAgainstSchema((toolBlock as any).input, DraftQuizSchema, { repair: false });
      if (!validated.ok) throw new Error(`Claude maker schema gate failed: ${validated.reason}`);
      return { raw: JSON.stringify((toolBlock as any).input), parsed: validated.value };
    },
  );
}

export async function runOpenAIMakerSimple(
  context: SomaGenerationContext,
  questionCount: number,
  distribution: { easy: number; medium: number; hard: number },
): Promise<DraftQuiz> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const client = new OpenAI({ apiKey });
  const systemPrompt = buildMakerSystemPrompt(context, questionCount, distribution);
  const userPrompt = `${buildMakerUserPrompt(context)}\n\nReturn JSON with shape: { "questions": [{stem, options[4], correct_answer, marks, difficulty_tag?, topic_tag?, subtopic_tag?}, ...] }`;

  return instrumentedCall<DraftQuiz>(
    "openai",
    "gpt-4o",
    systemPrompt,
    userPrompt,
    PromptIds.SOMA_MAKER,
    "generation",
    newRequestId(),
    async () => {
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const raw = completion.choices[0]?.message?.content || "";
      const validated = validateAgainstSchema(raw, DraftQuizSchema);
      if (!validated.ok) throw new Error(`OpenAI maker schema gate failed: ${validated.reason}`);
      return { raw, parsed: validated.value };
    },
  );
}

export async function runOpenAIVerifier(
  draftQuestions: DraftQuiz["questions"],
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; warnings: PipelineWarning[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const schema = zodToJsonSchema(VerifierResponseSchema, "VerifierResponse");
  const client = new OpenAI({ apiKey });
  const systemPrompt = buildVerifierSystemPrompt(context);
  const userPrompt = `${buildVerifierUserPrompt(draftQuestions, context)}\n\nReturn JSON matching this schema only:\n${JSON.stringify(schema)}`;

  return instrumentedCall(
    "openai",
    "gpt-4o",
    systemPrompt,
    userPrompt,
    PromptIds.SOMA_VERIFIER,
    "verification",
    newRequestId(),
    async () => {
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const raw = completion.choices[0]?.message?.content || "";
      const validated = validateAgainstSchema(raw, VerifierResponseSchema);
      if (!validated.ok) throw new Error(`OpenAI verifier schema gate failed: ${validated.reason}`);
      return { raw, parsed: { questions: validated.value.questions, warnings: validated.value.warnings ?? [] } };
    },
  );
}

export async function runGeminiVerifier(
  draftQuestions: DraftQuiz["questions"],
  context: SomaGenerationContext,
): Promise<{ questions: QuizResult["questions"]; warnings: PipelineWarning[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const schema = zodToJsonSchema(VerifierResponseSchema, "VerifierResponse");
  const systemPrompt = buildVerifierSystemPrompt(context);
  const userPrompt = buildVerifierUserPrompt(draftQuestions, context);

  return instrumentedCall(
    "google",
    "gemini-2.5-flash",
    systemPrompt,
    userPrompt,
    PromptIds.SOMA_VERIFIER,
    "verification",
    newRequestId(),
    async () => {
      const raw = await callGoogle("gemini-2.5-flash", systemPrompt, userPrompt, schema);
      const validated = validateAgainstSchema(raw, VerifierResponseSchema);
      if (!validated.ok) throw new Error(`Gemini verifier schema gate failed: ${validated.reason}`);
      return { raw, parsed: { questions: validated.value.questions, warnings: validated.value.warnings ?? [] } };
    },
  );
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
  // Batches are run in PARALLEL — they do not depend on each other, so a 30q
  // quiz takes ~the same wall-clock as a 15q quiz instead of double.
  if (questionCount > 15) {
    const batchSizes: number[] = [];
    let remaining = questionCount;
    while (remaining > 0) {
      const size = Math.min(15, remaining);
      batchSizes.push(size);
      remaining -= size;
    }

    const batchResults = await Promise.all(
      batchSizes.map((size) => generateAuditedQuiz({ ...context, questionCount: size })),
    );

    const merged: QuizResult["questions"] = [];
    const allWarnings: PipelineWarning[] = [];
    let lastTelemetry: PipelineTelemetry = {
      makerModel: "unknown", checkerModel: "unknown", polishModel: null, totalDurationMs: 0,
    };
    for (const batch of batchResults) {
      const baseIndex = merged.length;
      merged.push(...batch.questions);
      for (const w of batch.warnings) {
        allWarnings.push({ ...w, questionIndex: w.questionIndex + baseIndex });
      }
      lastTelemetry = batch.telemetry;
    }

    const finalValidated = validateAndCorrectMcqAnswers(merged.slice(0, questionCount));
    return {
      questions: finalValidated.questions,
      warnings: [...allWarnings, ...finalValidated.warnings],
      telemetry: { ...lastTelemetry, totalDurationMs: Date.now() - overallStart },
      seedMisconceptionIds: (context.examinerSeeds ?? []).map((s) => s.id),
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
  const guarded = applyDeterministicIntegrityGuards(verified.questions);
  const validated = validateAndCorrectMcqAnswers(guarded.questions);
  const mathCheck = applyMathValidatorCorrections(validated.questions);
  const finalQuestions = mathCheck.questions;

  return {
    questions: finalQuestions,
    warnings: [
      ...verified.warnings,
      ...guarded.warnings,
      ...validated.warnings,
      ...mathCheck.warnings,
    ],
    telemetry: {
      makerModel,
      checkerModel,
      polishModel: null,
      totalDurationMs: Date.now() - overallStart,
    },
    seedMisconceptionIds: (context.examinerSeeds ?? []).map((s) => s.id),
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
    const guarded = applyDeterministicIntegrityGuards(verified.questions);
    const validated = validateAndCorrectMcqAnswers(guarded.questions);
    const mathCheck = applyMathValidatorCorrections(validated.questions);
    return {
      questions: mathCheck.questions,
      warnings: [...verified.warnings, ...guarded.warnings, ...validated.warnings, ...mathCheck.warnings],
      verifierModel: "openai/gpt-4o",
    };
  } catch (err: any) {
    console.warn(`[COPILOT_AUDIT] ChatGPT verifier failed (${err?.message || "unknown"}); falling back to Gemini.`);
    try {
      const verified = await pipelineStages.runGeminiVerifier(draftQuestions, context);
      const guarded = applyDeterministicIntegrityGuards(verified.questions);
      const validated = validateAndCorrectMcqAnswers(guarded.questions);
      const mathCheck = applyMathValidatorCorrections(validated.questions);
      return {
        questions: mathCheck.questions,
        warnings: [...verified.warnings, ...guarded.warnings, ...validated.warnings, ...mathCheck.warnings],
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
