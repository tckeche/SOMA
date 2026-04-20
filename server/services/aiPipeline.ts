import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { generateWithFallback, callGoogle } from "./aiOrchestrator";
import Anthropic from "@anthropic-ai/sdk";
import { validateMathQuestion } from "./mathValidator";
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

const BlindCheckerAnswerSchema = z.object({
  questionIndex: z.number().int().min(1),
  inferredAnswer: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});

const BlindCheckerResponseSchema = z.object({
  answers: z.array(BlindCheckerAnswerSchema),
});

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

function normalizeAnswerText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\$/g, "")
    .replace(/[^a-z0-9.+\-/%() ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapBlindAnswerToOption(inferredAnswer: string, options: string[]): string | null {
  const normalizedBlind = normalizeAnswerText(inferredAnswer);
  if (!normalizedBlind) return null;

  // Direct and near-direct text matches first
  for (const option of options) {
    const normOpt = normalizeAnswerText(option);
    if (!normOpt) continue;
    if (normOpt === normalizedBlind) return option;
  }
  for (const option of options) {
    const normOpt = normalizeAnswerText(option);
    if (!normOpt) continue;
    if (normOpt.includes(normalizedBlind) || normalizedBlind.includes(normOpt)) return option;
  }

  // Letter fallback (A/B/C/D) if checker returns only the option letter.
  const letter = normalizedBlind.match(/^([a-d])(?:[\).:\s]|$)/i)?.[1]?.toUpperCase();
  if (letter) {
    const idx = letter.charCodeAt(0) - 65;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  return null;
}

async function runBlindAnswerConsensusCheck(
  questions: QuizResult["questions"],
  context: SomaGenerationContext,
): Promise<{ warnings: PipelineWarning[]; questions: QuizResult["questions"] }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!anthropicKey || !geminiKey || process.env.NODE_ENV === "test") {
    return { warnings: [], questions };
  }

  const solverPrompt = `You are a strict subject-matter checker for ${context.subject}.
Solve each question BLIND from the stem only. Do NOT use options because options can be wrong.
For each question return:
- questionIndex (1-based)
- inferredAnswer (the standalone best answer)
- confidence (0..1)
- rationale (brief)
Return valid JSON only.`;

  // Skip questions that the deterministic math validator can already verify.
  // This avoids paying LLM blind-check cost on items where Stage 4 has final authority.
  const candidateIndexes: number[] = [];
  const questionPayload: Array<{ questionIndex: number; stem: string }> = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const deterministic = validateMathQuestion(q.stem, q.options, q.correct_answer);
    if (deterministic.verifiable) continue;
    const questionIndex = i + 1;
    candidateIndexes.push(questionIndex);
    questionPayload.push({ questionIndex, stem: q.stem });
  }
  if (questionPayload.length === 0) {
    return { warnings: [], questions };
  }

  const catalogueBlock = context.catalogueContext
    ? `\n\nCatalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}`
    : "";
  const userPrompt = `Syllabus=${context.syllabus}; level=${context.level}; topic=${context.topic}${context.subtopic ? `; subtopic=${context.subtopic}` : ""}.${catalogueBlock}
Questions:
${JSON.stringify(questionPayload, null, 2)}`;

  const geminiPromise = (async () => {
    const schema = zodToJsonSchema(BlindCheckerResponseSchema, "BlindCheckerResponse");
    const raw = await callGoogle("gemini-2.5-flash", solverPrompt, userPrompt, schema);
    return BlindCheckerResponseSchema.parse(JSON.parse(raw));
  })();

  const claudePromise = (async () => {
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const wrapped: any = zodToJsonSchema(BlindCheckerResponseSchema, "BlindCheckerResponse");
    const inner: any = wrapped?.definitions?.BlindCheckerResponse ?? zodToJsonSchema(BlindCheckerResponseSchema);
    const inputSchema: any = { ...inner, type: inner?.type || "object" };
    delete inputSchema.$schema;
    delete inputSchema.$ref;
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8_192,
      temperature: 0,
      system: solverPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{
        name: "return_blind_check",
        description: "Return blind-check answers JSON.",
        input_schema: inputSchema,
      }],
      tool_choice: { type: "tool", name: "return_blind_check" },
    });
    const toolBlock = response.content.find((b: any) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") throw new Error("No Claude tool output");
    return BlindCheckerResponseSchema.parse(toolBlock.input);
  })();

  const [geminiResult, claudeResult] = await Promise.allSettled([geminiPromise, claudePromise]);
  const geminiParsed = geminiResult.status === "fulfilled" ? geminiResult.value : null;
  const claudeParsed = claudeResult.status === "fulfilled" ? claudeResult.value : null;
  if (geminiResult.status === "rejected") {
    const error: any = geminiResult.reason;
    console.warn(`[BLIND_CHECK][Gemini] Failed: ${error?.message || "unknown"}`);
  }
  if (claudeResult.status === "rejected") {
    const error: any = claudeResult.reason;
    console.warn(`[BLIND_CHECK][Claude] Failed: ${error?.message || "unknown"}`);
  }

  if (!geminiParsed || !claudeParsed) {
    return { warnings: [], questions };
  }

  const geminiByIndex = new Map(geminiParsed.answers.map((a) => [a.questionIndex, a]));
  const claudeByIndex = new Map(claudeParsed.answers.map((a) => [a.questionIndex, a]));

  const nextQuestions = [...questions];
  const warnings: PipelineWarning[] = [];
  for (const questionIndex of candidateIndexes) {
    const i = questionIndex - 1;
    const q = nextQuestions[i];
    const gem = geminiByIndex.get(questionIndex);
    const cla = claudeByIndex.get(questionIndex);
    if (!gem || !cla) continue;

    const gemMapped = mapBlindAnswerToOption(gem.inferredAnswer, q.options);
    const claMapped = mapBlindAnswerToOption(cla.inferredAnswer, q.options);

    if (!gemMapped || !claMapped) {
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: "Blind checkers could not confidently map inferred answers to options; question needs manual review.",
        autoFixed: false,
      });
      continue;
    }

    if (gemMapped !== claMapped) {
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: `Blind checker disagreement (Gemini="${gemMapped}" vs Claude="${claMapped}").`,
        autoFixed: false,
      });
      continue;
    }

    if (q.correct_answer !== gemMapped) {
      const blindExplanation = `Independent blind verification solved the stem answer as "${gem.inferredAnswer}" (Gemini) and "${cla.inferredAnswer}" (Claude), which maps to option "${gemMapped}".`;
      nextQuestions[i] = { ...q, correct_answer: gemMapped, explanation: blindExplanation };
      warnings.push({
        questionIndex,
        field: "correct_answer",
        issue: `Blind consensus overrode answer "${q.correct_answer}" -> "${gemMapped}".`,
        autoFixed: true,
      });
    }
  }

  return { warnings, questions: nextQuestions };
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

  const emergencyCatalogueBlock = context.catalogueContext
    ? `\n\n${formatCopilotContextAsText(context.catalogueContext)}`
    : "";
  const { data, metadata } = await generateWithFallback(
    emergencyPrompt,
    `Curriculum context:\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}${emergencyCatalogueBlock}`,
    jsonSchema,
  );
  return { result: extractJson(data), model: `${metadata.provider}/${metadata.model}` };
}

/**
 * Pipeline (Option C):
 *   1. MAKER         — GPT-4o (with fallback chain) creates questions
 *   2. GEMINI CHECK  — Gemini 2.5 Flash audits formatting + auto-fixes (cheap, ~50× cheaper than GPT-4o)
 *   3. CLAUDE POLISH — Only runs if checker surfaced warnings (skipped on clean output)
 *   4. Deterministic guards (free) — dedupe options, align answers
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
      makerModel: "unknown", checkerModel: "google/gemini-2.5-flash", polishModel: null, totalDurationMs: 0,
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

  // ── STAGE 1: MAKER (GPT-4o → fallback chain) ──────────────────────
  const makerPrompt = `You are an expert ${context.subject} assessment designer.
Generate exactly ${questionCount} MCQ questions for ${context.subject}.
STRICT SCOPE: syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.
Never drift to adjacent topics not explicitly in scope.
Difficulty mix target: easy=${distribution.easy}%, medium=${distribution.medium}%, hard=${distribution.hard}%.
Hard questions must involve reasoning/application (not recall).
For each question explanation, use 1–2 sentences: why the correct answer is right and why key distractors are wrong.

CRITICAL LATEX FORMATTING RULE — MANDATORY:
Every mathematical expression in EVERY stem, option, and explanation MUST be wrapped in LaTeX delimiters.
- Inline math: $...$  (e.g. $\\frac{1}{2}xe^{x^2}+C$, $\\sqrt{x^2+1}$, $x^2 + 3x - 4$)
- Display math: $$...$$ (for standalone equations)
NEVER output raw LaTeX commands without delimiters. NEVER write \\frac, \\sqrt, \\int, ^{, _{ outside of $...$ or $$...$$.
CURRENCY RULE: NEVER use a bare $ before a number for currency (e.g. $9,000). Write "9,000 dollars" or "USD 9,000".
SUBJECT ACCURACY RULE: Every question must be verifiably correct for ${context.subject}.`;

  let parsed: QuizResult;
  let makerModel = "unknown";
  try {
    const makerCatalogueBlock = context.catalogueContext
      ? `\n\nCatalogue context:\n${formatCopilotContextAsText(context.catalogueContext)}`
      : "";
    const { data, metadata } = await generateWithFallback(
      makerPrompt,
      `Topic: ${context.topic}${makerCatalogueBlock}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`,
      jsonSchema,
    );
    parsed = extractJson(data);
    makerModel = `${metadata.provider}/${metadata.model}`;
  } catch (error: any) {
    if (process.env.NODE_ENV === "test") throw error;
    console.warn(`[SOMA_PIPELINE] Maker failed, attempting emergency fallback. Reason: ${error?.message || "unknown"}`);
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

  // ── STAGE 2: GEMINI FORMATTING CHECK ──────────────────────────────
  const checkResult = await runGeminiFormattingCheck(parsed.questions, context);
  parsed.questions = checkResult.questions;
  const warnings = checkResult.warnings;

  // ── STAGE 3: CONDITIONAL CLAUDE POLISH ────────────────────────────
  // Cost gate: ONLY run Claude when the checker actually ran AND surfaced real
  // question-level issues. If the checker itself failed (checkerOk=false) the
  // warnings are availability noise, not content issues — polishing them wastes
  // ~$0.05/quiz.
  let polishModel: string | null = null;
  const polishWorthyWarnings = checkResult.checkerOk ? warnings : [];
  if (polishWorthyWarnings.length > 0) {
    const polishResult = await runClaudePolish(parsed.questions, polishWorthyWarnings, context);
    parsed.questions = polishResult.questions;
    if (polishResult.durationMs > 0) polishModel = "anthropic/claude-sonnet-4-6";
  }

  // ── STAGE 3.5: BLIND DUAL-CHECK CONSENSUS (Claude + Gemini) ───────
  // Cost gate: run only when checker raised issues, and only on non-deterministically
  // verifiable questions (math-verifiable questions are handled by Stage 4).
  if (checkResult.checkerOk && warnings.length > 0) {
    const blindCheckResult = await runBlindAnswerConsensusCheck(parsed.questions, context);
    parsed.questions = blindCheckResult.questions;
    warnings.push(...blindCheckResult.warnings);
  }

  // ── STAGE 4: DETERMINISTIC MATH VALIDATION ────────────────────────
  // For verifiable maths questions (function evaluation, arithmetic) we re-derive
  // the answer with a CAS and OVERRIDE the LLM if it disagrees. This is the last
  // line of defence against confidently-wrong AI arithmetic like "8 - 6 + 1 = 5".
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

  return {
    questions: parsed.questions,
    warnings,
    telemetry: {
      makerModel,
      checkerModel: "google/gemini-2.5-flash",
      polishModel,
      totalDurationMs: Date.now() - overallStart,
    },
  };
}
