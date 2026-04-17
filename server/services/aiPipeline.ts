import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { generateWithFallback } from "./aiOrchestrator";
import Anthropic from "@anthropic-ai/sdk";

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
 * Final Anthropic-only post-check pass to reduce mathematically incorrect answers.
 * Why this exists:
 * - The previous pipeline validated JSON shape + option alignment, but it did not
 *   guarantee symbolic/math correctness (e.g. calculus antiderivative slips).
 * - This pass re-solves each question and forces corrections before data is returned.
 */
async function runClaudePostCheck(
  questions: QuizResult["questions"],
  context: SomaGenerationContext,
): Promise<QuizResult["questions"]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.NODE_ENV === "test" || !apiKey) {
    console.warn("[SOMA_CLAUDE_POST_CHECK] Skipped (test mode or missing ANTHROPIC_API_KEY).");
    return questions;
  }

  const anthropic = new Anthropic({ apiKey });
  const schema = zodToJsonSchema(QuizResultSchema, "QuizResult");
  const systemPrompt = `You are Claude Post-Checker, the FINAL mathematical correctness gate for SOMA quiz questions.
Your job is to re-solve every question and ensure the marked correct answer is truly correct.
If a question is wrong, fix it.

Strict rules:
1. Return only a valid JSON object matching the provided schema.
2. Keep exactly the same number of questions.
3. Preserve each question stem intent and difficulty where possible.
4. Ensure correct_answer exactly equals one of the 4 options.
5. If the true answer is not in options, replace the weakest distractor with the true answer.
6. Rewrite explanation so it explicitly justifies the corrected answer.
7. Be especially careful with derivatives, integrals, algebraic signs, constants, and domain conditions.`;

  const userPrompt = `Context:
subject=${context.subject}
syllabus=${context.syllabus}
level=${context.level}
topic=${context.topic}
subtopic=${context.subtopic || "none"}

Questions JSON to audit and correct:
${JSON.stringify({ questions })}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16_384,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{
        name: "return_validated_quiz",
        description: "Return audited and corrected quiz JSON matching the schema.",
        input_schema: schema as any,
      }],
      tool_choice: { type: "tool", name: "return_validated_quiz" },
    });

    const toolBlock = response.content.find((block: any) => block.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      throw new Error("Claude post-check returned no tool output");
    }

    const parsed = QuizResultSchema.parse(toolBlock.input);
    console.log(`[SOMA_CLAUDE_POST_CHECK] Completed for ${parsed.questions.length} questions.`);
    return parsed.questions;
  } catch (error: any) {
    console.warn(`[SOMA_CLAUDE_POST_CHECK] Failed; keeping pre-check set. Reason: ${error?.message || "unknown error"}`);
    return questions;
  }
}

/**
 * Cross-provider adversarial verifier to harden correctness across ALL subjects.
 * Unlike the Claude-only pass, this uses the fallback chain so a single provider
 * mistake does not silently pass without challenge.
 */
async function runCrossSubjectVerifier(
  questions: QuizResult["questions"],
  context: SomaGenerationContext,
): Promise<QuizResult["questions"]> {
  const verifierPrompt = `You are a strict cross-subject examiner QA verifier.
Audit and correct every question for subject-matter truth, not style.

Verification requirements:
1. Re-solve / re-derive each answer where possible.
2. Ensure each correct_answer is objectively correct for ${context.subject}.
3. Ensure each explanation is logically valid and aligned with the corrected answer.
4. Keep exactly 4 distinct options and the same number of questions.
5. If a true answer is missing, replace the weakest distractor with the true answer.
6. Reject hidden answer leaks, contradiction, and self-inconsistent stems.
7. Keep syllabus/level scope: ${context.syllabus} / ${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.

Return strict JSON only, matching the schema.`;

  try {
    const { data } = await generateWithFallback(
      verifierPrompt,
      `Input quiz JSON:\n${JSON.stringify({ questions })}\n\nSupporting curriculum context:\n${context.supportingDocText || "None provided."}`,
      jsonSchema,
    );
    const parsed = extractJson(data);
    return parsed.questions;
  } catch (error: any) {
    console.warn(`[SOMA_CROSS_SUBJECT_VERIFIER] Failed; keeping current set. Reason: ${error?.message || "unknown error"}`);
    return questions;
  }
}

async function runThreeStageGeneration(
  context: SomaGenerationContext,
  questionCount: number,
  makerPrompt: string,
  checkerPrompt: string,
  finalizerPrompt: string,
): Promise<QuizResult> {
  const { data: maker } = await generateWithFallback(
    makerPrompt,
    `Topic: ${context.topic}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`,
    jsonSchema,
  );
  const { data: checker } = await generateWithFallback(
    checkerPrompt,
    `Topic: ${context.topic}\nInput JSON:\n${maker}`,
    jsonSchema,
  );
  const { data: final } = await generateWithFallback(
    finalizerPrompt,
    `Topic: ${context.topic}\nInput JSON:\n${checker}`,
    jsonSchema,
  );
  return extractJson(final);
}

async function runEmergencySingleStageGeneration(
  context: SomaGenerationContext,
  questionCount: number,
): Promise<QuizResult> {
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

  const { data } = await generateWithFallback(
    emergencyPrompt,
    `Curriculum context:\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`,
    jsonSchema,
  );
  return extractJson(data);
}

export async function generateAuditedQuiz(input: SomaGenerationContext | string): Promise<QuizResult> {
  const context: SomaGenerationContext = typeof input === "string"
    ? { topic: input, subject: "Mathematics", syllabus: "IEB", level: "Grade 6-12" }
    : input;

  const questionCount = Math.max(1, Math.min(50, context.questionCount ?? 8));
  if (questionCount > 20) {
    const batchSize = 15;
    const merged: QuizResult["questions"] = [];
    let remaining = questionCount;
    while (remaining > 0) {
      const currentBatch = Math.min(batchSize, remaining);
      const batch = await generateAuditedQuiz({ ...context, questionCount: currentBatch });
      merged.push(...batch.questions);
      remaining -= currentBatch;
    }
    return { questions: validateAndCorrectMcqAnswers(merged.slice(0, questionCount)) };
  }
  const distribution = context.difficultyDistribution ?? { easy: 25, medium: 50, hard: 25 };
  const makerPrompt = `You are Claude (Maker), an expert ${context.subject} assessment designer.
Generate exactly ${questionCount} MCQ questions for ${context.subject}.
STRICT SCOPE: syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.
Never drift to adjacent topics not explicitly in scope.
Difficulty mix target: easy=${distribution.easy}%, medium=${distribution.medium}%, hard=${distribution.hard}%.
Hard questions must involve reasoning/application (not recall).
For each question explanation, use 1–2 sentences: why the correct answer is right and why key distractors are wrong.

CRITICAL LATEX FORMATTING RULE — THIS IS MANDATORY AND NON-NEGOTIABLE:
Every mathematical expression in EVERY stem, option, and explanation MUST be wrapped in LaTeX delimiters.
- Inline math: $...$  (e.g. $\\frac{1}{2}xe^{x^2}+C$, $\\sqrt{x^2+1}$, $x^2 + 3x - 4$)
- Display math: $$...$$ (for standalone equations)
NEVER output raw LaTeX commands without delimiters. NEVER write \\frac, \\sqrt, \\int, ^{, _{ outside of $...$ or $$...$$. Every answer option that contains any mathematical notation must start and end with $ delimiters.
CURRENCY RULE: When writing monetary amounts (e.g. $9,000 or $100,000), write them as plain text WITHOUT a dollar sign prefix, or use the word "dollars" — NEVER use a bare $ before a number as this will be parsed as a math delimiter. WRONG: "$9,000" RIGHT: "9,000 dollars" or "USD 9,000".
SUBJECT ACCURACY RULE: Every question must be verifiably correct for ${context.subject}.`;
  const checkerPrompt = `You are Gemini (Checker). Audit the Maker JSON with strict accuracy.
You must evaluate ONLY the provided topic/context and input JSON.
Do not hallucinate facts, syllabus requirements, or missing context.
Reject or correct anything unsupported by the provided data.
Enforce subject-matter correctness for ${context.subject}, strict JSON structure, and syllabus-level alignment (${context.syllabus}/${context.level}).
Return only validated JSON that is fully supported by the given input.

LATEX VALIDATION — CHECK EVERY FIELD:
Scan every stem, every option, and every explanation. Any mathematical expression NOT wrapped in $...$ or $$...$$ must be fixed by wrapping it. Raw LaTeX commands (\\frac, \\sqrt, \\int, ^{, _{) MUST be inside $ delimiters. Fix them if the Maker missed any.`;
  const finalizerPrompt = `Perform final curriculum compliance and syllabus audit.
Reject questions outside topic/subtopic scope.
Return strictly valid JSON only with exactly ${questionCount} questions.`;

  let parsed: QuizResult;
  try {
    parsed = await runThreeStageGeneration(context, questionCount, makerPrompt, checkerPrompt, finalizerPrompt);
  } catch (error: any) {
    if (process.env.NODE_ENV === "test") throw error;
    console.warn(`[SOMA_PIPELINE] Three-stage generation failed, attempting emergency fallback. Reason: ${error?.message || "unknown error"}`);
    parsed = await runEmergencySingleStageGeneration(context, questionCount);
  }
  const scopeTokens = [context.topic, context.subtopic].filter(Boolean).join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  if (scopeTokens.length > 0) {
    const scoped = parsed.questions.filter((q) => {
      const hay = `${q.stem} ${q.explanation} ${q.topic_tag || ""} ${q.subtopic_tag || ""}`.toLowerCase();
      return scopeTokens.some((token) => hay.includes(token));
    });
    if (scoped.length > 0) {
      parsed.questions = scoped;
    }
  }
  if (parsed.questions.length < questionCount && parsed.questions.length > 0) {
    console.warn(`[SOMA_GENERATION_SCOPE] Only ${parsed.questions.length}/${questionCount} questions strongly matched topic scope; keeping best validated set.`);
  }
  parsed.questions = parsed.questions.slice(0, questionCount);
  parsed.questions = applyDeterministicIntegrityGuards(parsed.questions);
  parsed.questions = validateAndCorrectMcqAnswers(parsed.questions);
  parsed.questions = await runClaudePostCheck(parsed.questions, context);
  parsed.questions = await runCrossSubjectVerifier(parsed.questions, context);
  parsed.questions = applyDeterministicIntegrityGuards(parsed.questions);
  parsed.questions = validateAndCorrectMcqAnswers(parsed.questions);
  return parsed;
}
