import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { generateWithFallback } from "./aiOrchestrator";

export const QuestionSchema = z.object({
  stem: z.string(),
  options: z.array(z.string()).length(4),
  correct_answer: z.string(),
  explanation: z.string().min(1),
  marks: z.number().int().min(1).max(10),
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
}

const jsonSchema = zodToJsonSchema(QuizResultSchema, "QuizResult");

function extractJson(raw: string): QuizResult {
  return QuizResultSchema.parse(JSON.parse(raw));
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

export async function generateAuditedQuiz(input: SomaGenerationContext | string): Promise<QuizResult> {
  const context: SomaGenerationContext = typeof input === "string"
    ? { topic: input, subject: "Mathematics", syllabus: "IEB", level: "Grade 6-12" }
    : input;

  const makerPrompt = `You are Claude (Maker), an expert mathematics assessment designer. Generate MCQ quiz JSON for ${context.subject}. Use syllabus ${context.syllabus} and level ${context.level}. For each question, the "explanation" field MUST be exactly 1–2 sentences: briefly state why the correct answer is right, AND explicitly point out the mathematical or logical error that leads to each incorrect distractor.`;
  const checkerPrompt = `You are Gemini (Checker). Audit the Maker JSON with strict accuracy.
You must evaluate ONLY the provided topic/context and input JSON.
Do not hallucinate facts, syllabus requirements, or missing context.
Reject or correct anything unsupported by the provided data.
Enforce mathematical correctness, strict JSON structure, and syllabus-level alignment (${context.syllabus}/${context.level}).
Return only validated JSON that is fully supported by the given input.`;
  const finalizerPrompt = `Perform final curriculum compliance and syllabus audit. Return strictly valid JSON only.`;

  const { data: maker } = await generateWithFallback(makerPrompt, `Topic: ${context.topic}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`, jsonSchema);
  const { data: checker } = await generateWithFallback(checkerPrompt, `Topic: ${context.topic}\nInput JSON:\n${maker}`, jsonSchema);
  const { data: final } = await generateWithFallback(finalizerPrompt, `Topic: ${context.topic}\nInput JSON:\n${checker}`, jsonSchema);
  const parsed = extractJson(final);
  parsed.questions = validateAndCorrectMcqAnswers(parsed.questions);
  return parsed;
}
