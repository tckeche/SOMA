/**
 * Deterministic per-question QUALITY GATE.
 *
 * Pure, side-effect-free checks that flag genuinely broken MCQ questions so
 * they are never served to students. No I/O, no LLM calls — every result is a
 * deterministic function of the input. Hard failures BLOCK (auto_blocked);
 * soft issues WARN (needs_review).
 */
import { numericallyEquivalent, explanationFinalAnswerMismatch } from "./mathValidator";

export interface QualityContext {
  subject?: string;
  syllabus?: string;
  level?: string;
  topic?: string;
  subtopic?: string;
}

export interface QualityResult {
  reviewStatus: "approved" | "needs_review" | "auto_blocked";
  blocking: string[]; // hard failures -> auto_blocked
  warnings: string[]; // soft issues  -> needs_review
}

export interface QualityInput {
  stem: string;
  options: string[];
  correct_answer: string;
  explanation?: string;
  difficulty_tag?: string;
}

const SENTINEL_PREFIX = "[OPTION GENERATION FAILED";

const VALID_DIFFICULTY = new Set(["easy", "medium", "hard"]);

/** trim + lowercase + collapse internal whitespace */
function normalizeOption(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Words of length >= 4, lowercased, alpha-only. */
function keywordTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4);
}

export function validateQuestionQuality(q: QualityInput, _ctx?: QualityContext): QualityResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const options = Array.isArray(q.options) ? q.options : [];

  // 1. Exactly 4 options.
  if (options.length !== 4) {
    blocking.push(`expected 4 options but got ${options.length}`);
  }

  // 2. Sentinel option (generation failure marker).
  if (options.some((o) => String(o).trim().startsWith(SENTINEL_PREFIX))) {
    blocking.push("option contains the generation-failure sentinel");
  }

  // 3. Exactly one option equals the correct answer (by trimmed text).
  const correctTrim = String(q.correct_answer ?? "").trim();
  const correctMatches = options.filter((o) => String(o).trim() === correctTrim).length;
  if (correctMatches !== 1) {
    blocking.push(
      correctMatches === 0
        ? "correct answer is not present among the options"
        : "correct answer matches more than one option",
    );
  }

  // 4. Duplicate / equivalent distractors.
  const normalized = options.map(normalizeOption);
  let duplicateFound = false;
  for (let i = 0; i < options.length && !duplicateFound; i++) {
    for (let j = i + 1; j < options.length; j++) {
      if (normalized[i] === normalized[j] || numericallyEquivalent(options[i], options[j])) {
        duplicateFound = true;
        break;
      }
    }
  }
  if (duplicateFound) {
    blocking.push("two options are equivalent");
  }

  // 5. Explanation consistency.
  const explanation = (q.explanation ?? "").trim();
  if (explanation) {
    const { mismatch, complex } = explanationFinalAnswerMismatch(
      q.stem,
      options,
      q.correct_answer,
      explanation,
    );
    if (mismatch && complex) {
      blocking.push("explanation contradicts the marked correct answer");
    } else if (mismatch && !complex) {
      warnings.push("explanation may not state the marked correct answer");
    }
  }

  // 6. Length bias — correct option conspicuously longer than distractors.
  if (correctMatches === 1) {
    const correctIdx = options.findIndex((o) => String(o).trim() === correctTrim);
    const correctLen = options[correctIdx].length;
    const distractorLens = options
      .filter((_, i) => i !== correctIdx)
      .map((o) => o.length);
    if (distractorLens.length === 3) {
      const med = median(distractorLens);
      const isLongest = distractorLens.every((l) => correctLen > l);
      if (isLongest && med > 0 && correctLen > med * 1.6) {
        warnings.push("correct option is conspicuously longer than distractors");
      }
    }
  }

  // 7. Invalid difficulty tag.
  if (q.difficulty_tag && !VALID_DIFFICULTY.has(q.difficulty_tag)) {
    warnings.push(`unknown difficulty tag "${q.difficulty_tag}"`);
  }

  // 8. Stem reveal — answer keyword in the stem but not in any distractor.
  if (correctMatches === 1) {
    const correctIdx = options.findIndex((o) => String(o).trim() === correctTrim);
    const correctTokens = keywordTokens(options[correctIdx]);
    if (correctTokens.length > 0) {
      const stemLower = q.stem.toLowerCase();
      const distractorTokens = options
        .filter((_, i) => i !== correctIdx)
        .map((o) => new Set(keywordTokens(o)));
      const revealed = correctTokens.some(
        (tok) =>
          stemLower.includes(tok) &&
          distractorTokens.every((set) => !set.has(tok)),
      );
      if (revealed) {
        warnings.push("answer keyword appears in the stem but not in distractors");
      }
    }
  }

  const reviewStatus: QualityResult["reviewStatus"] =
    blocking.length > 0 ? "auto_blocked" : warnings.length > 0 ? "needs_review" : "approved";

  return { reviewStatus, blocking, warnings };
}
