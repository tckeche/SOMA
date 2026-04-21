import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { callGoogle } from "./aiOrchestrator";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  formatCopilotContextAsText,
  type CatalogueCopilotContext,
} from "./copilotContext";

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
  /**
   * Rich catalogue-driven context (Phase 6). When present, its serialised text
   * digest is injected into the Maker/Checker/Polisher user prompts on top of
   * the legacy string fields. Legacy free-text callers can omit it.
   */
  catalogueContext?: CatalogueCopilotContext;
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

  const catalogueBlock = context.catalogueContext
    ? `Catalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}\n\n`
    : "";
  const userPrompt = `${catalogueBlock}Audit and fix these ${questions.length} questions:\n${JSON.stringify({ questions }, null, 2)}`;

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
    const polishCatalogueBlock = context.catalogueContext
      ? `Catalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}\n\n`
      : "";
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16_384,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: `${polishCatalogueBlock}Polish these questions:\n${JSON.stringify({ questions })}` }],
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

/**
 * Pipeline (two-stage):
 *   1. MAKER    — Claude drafts the questions (fallback: ChatGPT).
 *   2. VERIFIER — ChatGPT checks correctness, fixes any wrong answers, and
 *                 writes the Soma tutor explanation AFTER the answer is
 *                 verified (fallback: Gemini; also used if Claude maker failed
 *                 and ChatGPT had to take over the maker role).
 *   3. Deterministic integrity guards + MCQ answer snapping.
 *
 * Returns questions + warnings (for Co-Pilot UI) + telemetry (for cost tracking).
 */
export async function generateAuditedQuiz(input: SomaGenerationContext | string): Promise<AuditedQuizResult> {
  const overallStart = Date.now();
  const context: SomaGenerationContext = typeof input === "string"
    ? { topic: input, subject: "Mathematics", syllabus: "IEB", level: "Grade 6-12" }
    : input;

  const questionCount = Math.max(1, Math.min(50, context.questionCount ?? 8));
  const distribution = context.difficultyDistribution ?? { easy: 25, medium: 50, hard: 25 };

  // Batch large quizzes — recurse with smaller counts and merge
  if (questionCount > 15) {
    const batchSize = 15;
    const merged: QuizResult["questions"] = [];
    const allWarnings: PipelineWarning[] = [];
    let lastTelemetry: PipelineTelemetry = {
      makerModel: "unknown", checkerModel: "unknown", polishModel: null, totalDurationMs: 0,
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

  // ── STAGE 1: MAKER ──────────────────────────────────────────────────────
  // Happy path: Claude. Fallback: ChatGPT. That dictates which verifier runs.
  let draft: DraftQuiz;
  let makerModel: string;
  let claudeMadeIt = false;
  try {
    draft = await pipelineStages.runClaudeMakerSimple(context, questionCount, distribution);
    makerModel = "anthropic/claude-sonnet-4-6";
    claudeMadeIt = true;
  } catch (error: any) {
    console.warn(`[SOMA_PIPELINE] Claude maker failed (${error?.message || "unknown"}); falling back to ChatGPT maker.`);
    draft = await pipelineStages.runOpenAIMakerSimple(context, questionCount, distribution);
    makerModel = "openai/gpt-4o";
  }

  // Scope filter (cheap, deterministic) + cap at requested count
  const scopeTokens = [context.topic, context.subtopic].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  if (scopeTokens.length > 0) {
    const scoped = draft.questions.filter((q) => {
      const hay = `${q.stem} ${q.topic_tag || ""} ${q.subtopic_tag || ""}`.toLowerCase();
      return scopeTokens.some((token) => hay.includes(token));
    });
    if (scoped.length > 0) draft.questions = scoped;
  }
  if (draft.questions.length < questionCount && draft.questions.length > 0) {
    console.warn(`[SOMA_PIPELINE] Only ${draft.questions.length}/${questionCount} questions strongly matched topic scope; keeping best set.`);
  }
  draft.questions = draft.questions.slice(0, questionCount);

  // ── STAGE 2: VERIFIER (verify + fix + write Soma tutor explanation) ─────
  // If Claude made it: primary verifier = ChatGPT, fallback = Gemini.
  // If ChatGPT made it: verifier = Gemini (tier-2 path).
  let verified: { questions: QuizResult["questions"]; warnings: PipelineWarning[] };
  let checkerModel: string;
  if (claudeMadeIt) {
    try {
      verified = await pipelineStages.runOpenAIVerifier(draft.questions, context);
      checkerModel = "openai/gpt-4o";
    } catch (error: any) {
      console.warn(`[SOMA_PIPELINE] ChatGPT verifier failed (${error?.message || "unknown"}); falling back to Gemini verifier.`);
      verified = await pipelineStages.runGeminiVerifier(draft.questions, context);
      checkerModel = "google/gemini-2.5-flash";
    }
  } else {
    verified = await pipelineStages.runGeminiVerifier(draft.questions, context);
    checkerModel = "google/gemini-2.5-flash";
  }

  // Final deterministic guards (cheap, free — normalises marks, de-dupes options,
  // snaps correct_answer to a real option if the LLM used a letter like "A").
  const finalQuestions = validateAndCorrectMcqAnswers(applyDeterministicIntegrityGuards(verified.questions));

  return {
    questions: finalQuestions,
    warnings: verified.warnings,
    telemetry: {
      makerModel,
      checkerModel,
      polishModel: null,
      totalDurationMs: Date.now() - overallStart,
    },
  };
}

// Maker emits a DRAFT (no explanations). Verifier checks correctness, fixes
// the answer if needed, then writes the Soma tutor explanation. This keeps the
// explanation in sync with the final answer and spends zero tokens on
// explanations that would be thrown away.

const SOMA_TUTOR_VOICE = `Write explanations in the Soma tutor voice: encouraging but objective.
- Affirm the correct reasoning directly; no flattery or emotive language.
- State clearly WHY the correct answer is correct using syllabus-level reasoning.
- Briefly note why the most plausible distractor is wrong.
- Use precise educator phrasing. 2-4 sentences per explanation.`;

// Draft question has no explanation — the verifier writes it after the answer
// is confirmed correct, so we never spend tokens on an explanation that might
// be thrown away if the answer changes.
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
- Do NOT write the explanation field — that is done later by the verifier.`;
}

function buildMakerUserPrompt(context: SomaGenerationContext): string {
  const catalogueBlock = context.catalogueContext
    ? `\n\nCatalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}`
    : "";
  return `Topic: ${context.topic}${catalogueBlock}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`;
}

function buildVerifierSystemPrompt(context: SomaGenerationContext): string {
  return `You are the SOMA question verifier. For EACH question you receive:

1. CHECK that the correct_answer is objectively correct, in-scope for subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}, solvable, and that the 4 options are distinct.
2. If the answer is wrong, FIX it: change correct_answer to the right option, or rewrite an option if all 4 are wrong. If the question itself is unsalvageable, rewrite the stem minimally to make a clear, correct question.
3. Once the answer is correct, WRITE the explanation field in this voice:

${SOMA_TUTOR_VOICE}

Return the FULL corrected question set — same count, same order. For every fix you made, add a warning entry with autoFixed=true. Never drop or add questions.`;
}

function buildVerifierUserPrompt(
  questions: DraftQuiz["questions"],
  context: SomaGenerationContext,
): string {
  const catalogueBlock = context.catalogueContext
    ? `Catalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}\n\n`
    : "";
  return `${catalogueBlock}Verify, fix, and explain these ${questions.length} questions:\n${JSON.stringify({ questions }, null, 2)}`;
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
      { role: "user", content: `${buildMakerUserPrompt(context)}\n\nReturn JSON with shape: { "questions": [{stem, options[4], correct_answer, marks, difficulty_tag?, topic_tag?, subtopic_tag?}, ...] }` },
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
      { role: "user", content: `${buildVerifierUserPrompt(draftQuestions, context)}\n\nReturn JSON matching this schema only:\n${JSON.stringify(schema)}` },
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

// Mutable indirection so tests can swap stages without splitting the module.
// `generateAuditedQuiz` dispatches through `pipelineStages.X` rather than the
// raw function reference, so tests can reassign properties here.
export const pipelineStages = {
  runClaudeMakerSimple,
  runOpenAIMakerSimple,
  runOpenAIVerifier,
  runGeminiVerifier,
};
