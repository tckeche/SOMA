import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { callGoogle } from "./aiOrchestrator";
import {
  formatCopilotContextAsText,
  type CatalogueCopilotContext,
} from "./copilotContext";
import { validateMathQuestion, explanationFinalAnswerMismatch, parseNumericValue, numericallyEquivalent } from "./mathValidator";
import { recordCall, newRequestId } from "../utils/aiTelemetry";
import * as health from "./aiHealth";
import { clampMaxTokens } from "./aiCostGuards";
import { renderSeedsForPrompt } from "./examinerDistractorSeeds";
import { describePrompt, PromptIds } from "./aiPromptRegistry";
import { validateAgainstSchema } from "./aiContracts";
import {
  distributeDifficulty,
  inferPurposeFromPrompt,
  renderBlueprintForMaker,
  runBlueprintPlanner,
  type Blueprint,
  type GenerationPurpose,
} from "./aiBlueprint";

// ─── Schemas ────────────────────────────────────────────────────────────────

export const OptionRationaleSchema = z.object({
  /** The option text this rationale describes — must match options[i] verbatim. */
  option: z.string(),
  /** True for the correct answer, false for distractors. Exactly one row should be true. */
  isCorrect: z.boolean(),
  /** 1-2 sentence explanation: why correct, or which step a student got wrong to land here. */
  rationale: z.string().min(1),
  /** When this distractor reproduces a known examiner-flagged misconception, the seed id; null otherwise. */
  misconceptionId: z.number().int().nullable(),
});

export const QuestionSchema = z.object({
  stem: z.string(),
  options: z.array(z.string()).length(4),
  correct_answer: z.string(),
  explanation: z.string().min(1),
  marks: z.number().int().min(1).max(10),
  difficulty_tag: z.enum(["easy", "medium", "hard"]).optional(),
  topic_tag: z.string().optional(),
  subtopic_tag: z.string().optional(),
  /**
   * Phase 4 — per-option rationales. Optional during rollout: legacy
   * verifiers that haven't been re-prompted still produce only `explanation`.
   * When present, must have exactly 4 rows, in the same order as `options`,
   * and exactly one row with isCorrect=true.
   */
  option_rationales: z.array(OptionRationaleSchema).length(4).optional(),
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
  /**
   * Phase 4 — number of re-roll passes that ran to backfill questions
   * blocked by the disagreement protocol. 0 = first pass shipped a full
   * quiz; N = N additional passes ran.
   */
  rerollAttempts?: number;
  /**
   * Phase 4 — number of originally-blocked slots that a re-roll filled.
   * Equals (initial blocks) - (final blocks).
   */
  recoveredCount?: number;
}

export interface AuditedQuizResult {
  questions: QuizResult["questions"];
  warnings: PipelineWarning[];
  telemetry: PipelineTelemetry;
  /** Examiner-misconception ids the batch was seeded against (Phase 2B).
   *  Persist on each question's `target_misconception_ids` so the marker
   *  can cite the matched insight. */
  seedMisconceptionIds: number[];
  /**
   * Phase 3 — the per-question blueprint used during this generation. Null
   * when the planner was skipped (no catalogue anchors AND no examiner
   * seeds — nothing for the planner to ground on). When present, callers
   * can persist `blueprint.rows[i]` alongside questions[i] for traceable
   * attribution back to learning requirements and misconceptions.
   */
  blueprint: Blueprint | null;
  /**
   * Phase 4 — questions the disagreement protocol blocked rather than
   * shipping with a coerced/wrong answer key. The result's `questions`
   * array is shorter than questionCount when this is non-empty. Callers
   * can inspect `blockedQuestions[i].rejected` to re-roll, surface to a
   * tutor for manual review, or simply ship a shorter assignment.
   */
  blockedQuestions: BlockedQuestion[];
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
  /**
   * Phase 3 — assignment purpose drives the blueprint planner's allocation
   * between syllabus-coverage rows and misconception-probe rows. When
   * unset, the planner infers from `copilotPrompt` ("Purpose: <slug>") so
   * existing callers don't need a route-side change to benefit.
   */
  purpose?: GenerationPurpose;
  /**
   * Phase 3 — pre-computed blueprint plan. The pipeline normally builds
   * this itself in Stage 0 by calling `runBlueprintPlanner`, but tests can
   * inject a fixed plan to make assertions deterministic.
   */
  blueprint?: Blueprint;
  /**
   * Phase 4 — maximum number of re-roll passes if the disagreement
   * protocol blocks any questions. The pipeline will re-generate the
   * blocked count up to this many times so the assignment ships at full
   * length. Defaults to 2 (so up to 3 total passes). Set to 0 to opt out
   * and accept short assignments.
   */
  maxRerollAttempts?: number;
  /**
   * Internal flag set when a re-roll calls back into generateAuditedQuiz —
   * prevents infinite recursion. Callers should not set this.
   */
  _disableReroll?: boolean;
}

// ─── Soma tutor voice ───────────────────────────────────────────────────────

const SOMA_TUTOR_VOICE = `Write each explanation in the Soma tutor voice: encouraging but objective.
- Affirm the correct reasoning directly. No flattery, no emotive filler.
- State clearly WHY the correct answer is correct using syllabus-level reasoning.
- Briefly note why the most plausible distractor is wrong.
- Use precise educator phrasing. 2-4 sentences per explanation.`;

// ─── Deterministic helpers ──────────────────────────────────────────────────

// Visible sentinel emitted when dedupe collapses the option set below 4. We
// must still ship 4 options to satisfy the schema, but a sentinel is far
// safer than the previous "Option 1"/"Option 2" placeholder which looked
// like real content — students would see plausible-looking text and a
// reviewer skimming the quiz might miss it. The OPTION_GAP_PREFIX makes
// the bug obvious and is paired with a CRITICAL pipeline warning so the
// builder co-pilot surfaces it before publication.
const OPTION_GAP_PREFIX = "[OPTION GENERATION FAILED — please regenerate";

function isGapSentinel(opt: string): boolean {
  return opt.startsWith(OPTION_GAP_PREFIX);
}

interface DedupeOptionsResult {
  options: string[];
  /** Number of placeholder options inserted to satisfy the 4-option schema. */
  gaps: number;
}

function dedupeOptions(options: string[], preferred?: string): DedupeOptionsResult {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    const normalized = option.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(option.trim());
  }
  // Only insert `preferred` when dedupe has collapsed the option set below 4
  // (the genuine duplicate-options case). When we already have 4 unique
  // options, an unshift+slice(0,4) would silently rescue a hallucinated
  // correct_answer by evicting a real option — exactly the silent-coerce
  // the disagreement protocol needs to catch, not paper over.
  if (preferred && out.length < 4 && !out.some((o) => o.trim() === preferred.trim())) {
    out.unshift(preferred.trim());
  }
  let gaps = 0;
  while (out.length < 4) {
    gaps++;
    out.push(`${OPTION_GAP_PREFIX} #${gaps}]`);
  }
  return { options: out.slice(0, 4), gaps };
}

/**
 * Normalise a free-text difficulty tag to one of "easy"/"medium"/"hard".
 * Lowercases + trims; anything that isn't a known bucket becomes undefined so
 * stored tags stay clean and drift reporting/quality gates don't trip on it.
 */
export function normalizeDifficultyTag(
  tag: string | undefined,
): "easy" | "medium" | "hard" | undefined {
  if (typeof tag !== "string") return undefined;
  const t = tag.trim().toLowerCase();
  return t === "easy" || t === "medium" || t === "hard" ? t : undefined;
}

/**
 * Compare the realised difficulty distribution of a finished question set
 * against the requested target and, if any bucket has drifted beyond
 * tolerance, return ONE summary warning. Pure + side-effect free so it can be
 * unit-tested directly. `distribution` is the requested percentage mix.
 */
export function computeDifficultyDriftWarning(
  questions: Array<{ difficulty_tag?: string }>,
  distribution: { easy: number; medium: number; hard: number },
): PipelineWarning | null {
  const n = questions.length;
  if (n === 0) return null;
  const target = distributeDifficulty(n, distribution);
  const actual = { easy: 0, medium: 0, hard: 0 };
  let unspecified = 0;
  for (const q of questions) {
    const tag = normalizeDifficultyTag(q.difficulty_tag);
    if (tag) actual[tag] += 1;
    else unspecified += 1;
  }
  const tolerance = Math.max(1, Math.round(0.1 * n));
  const drifted = (["easy", "medium", "hard"] as const).some(
    (k) => Math.abs(actual[k] - target[k]) > tolerance,
  );
  if (!drifted) return null;
  return {
    questionIndex: 0,
    field: "overall",
    issue:
      `Difficulty drift: requested easy=${target.easy}/med=${target.medium}/hard=${target.hard}, ` +
      `got easy=${actual.easy}/med=${actual.medium}/hard=${actual.hard} (${unspecified} unspecified).`,
    autoFixed: false,
  };
}

export function applyDeterministicIntegrityGuards(
  questions: QuizResult["questions"],
): { questions: QuizResult["questions"]; warnings: PipelineWarning[] } {
  const warnings: PipelineWarning[] = [];
  const corrected = questions.map((q, idx) => {
    const normalizedStem = q.stem.trim();
    const normalizedCorrect = q.correct_answer.trim();
    const normalizedExplanation = q.explanation.trim() || "See worked method for the correct option.";
    const dedupeResult = dedupeOptions(q.options, normalizedCorrect);
    const guardedOptions = dedupeResult.options;
    if (dedupeResult.gaps > 0) {
      warnings.push({
        questionIndex: idx + 1,
        field: "options",
        issue: `CRITICAL: only ${4 - dedupeResult.gaps} unique option(s) survived dedupe — ${dedupeResult.gaps} placeholder slot(s) were inserted with the "${OPTION_GAP_PREFIX} #N]" sentinel. Regenerate this question before publishing or students will see broken option text.`,
        autoFixed: false,
      });
    }
    const marks = Number.isInteger(q.marks) ? Math.min(10, Math.max(1, q.marks)) : 1;
    // Normalise difficulty_tag for clean reporting: lowercase + trim, and drop
    // anything that isn't one of the three known buckets so downstream drift
    // accounting and quality gates don't trip on stray casing/values.
    const normalizedDifficulty = normalizeDifficultyTag(q.difficulty_tag);
    const cleaned = {
      ...q,
      stem: normalizedStem || `Question ${idx + 1}`,
      options: guardedOptions,
      correct_answer: normalizedCorrect || guardedOptions[0],
      explanation: normalizedExplanation,
      marks,
      difficulty_tag: normalizedDifficulty,
    };
    // dedupeOptions pads with "Option N" placeholders when the model returned
    // fewer than 4 distinct options. A student must never see that — mark
    // CRITICAL (unfixed) so the disagreement protocol blocks the question
    // and the re-roll loop regenerates it.
    const originalSet = new Set(q.options.map((o) => o.trim()));
    const placeholders = guardedOptions.filter((o) => /^Option [1-4]$/.test(o) && !originalSet.has(o));
    if (placeholders.length > 0) {
      warnings.push({
        questionIndex: idx + 1,
        field: "options",
        issue: `CRITICAL: model returned only ${guardedOptions.length - placeholders.length} distinct option(s); ${placeholders.length} placeholder option(s) were padded in. Question is unusable as-is.`,
        autoFixed: false,
      });
    }
    if (guardedOptions.includes(cleaned.correct_answer)) return cleaned;
    // The verifier's correct_answer is not among the 4 valid options. Do
    // NOT silently rescue by setting correct_answer = options[0] — that
    // would ship a wrong key. Mark CRITICAL and pass through unchanged so
    // the downstream answer-validator and disagreement protocol can also
    // try to recover (letter / substring / math) and, failing that, block
    // the question entirely.
    warnings.push({
      questionIndex: idx + 1,
      field: "correct_answer",
      issue: `CRITICAL: stored correct_answer "${cleaned.correct_answer}" did not survive option dedupe/normalisation — verifier produced an answer not present in the 4 options.`,
      autoFixed: false,
    });
    return cleaned;
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
    }

    // Numeric answers get an exact value match, never substring matching —
    // substring scoring happily snapped "12" onto "123" (67% overlap), which
    // is a wrong answer key. Equality is by parsed value, so "0.5",
    // "\\frac{1}{2}" and "1/2" all match each other.
    const answerNum = parseNumericValue(q.correct_answer);
    if (answerNum !== null) {
      const numericIdx = q.options.findIndex((o) => numericallyEquivalent(o, q.correct_answer));
      if (numericIdx >= 0) {
        warnings.push({
          questionIndex: idx + 1,
          field: "correct_answer",
          issue: `Verifier's correct_answer "${q.correct_answer}" is numerically equal to option "${q.options[numericIdx]}"; auto-snapped.`,
          autoFixed: true,
        });
        return { ...q, correct_answer: q.options[numericIdx] };
      }
      warnings.push({
        questionIndex: idx + 1,
        field: "correct_answer",
        issue: `CRITICAL: verifier's numeric correct_answer "${q.correct_answer}" does not equal ANY of the 4 options. Defaulted to "${q.options[0]}" so the quiz is savable, but the answer key is unverifiable — REVIEW THIS QUESTION MANUALLY before publishing or students may be marked wrong on the right answer.`,
        autoFixed: false,
      });
      return { ...q, correct_answer: q.options[0] };
    }

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < q.options.length; i++) {
      const optNorm = q.options[i].trim().toLowerCase().replace(/\s+/g, " ");
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

/**
 * Flag questions whose explanation contradicts the marked correct option (the
 * explanation never states the verified answer). Used by the Copilot audit
 * flow, which surfaces drafts to the tutor for review rather than hard-blocking.
 */
function flagExplanationContradictions(
  questions: QuizResult["questions"],
): PipelineWarning[] {
  const warnings: PipelineWarning[] = [];
  questions.forEach((q, idx) => {
    if (!q.explanation) return;
    const r = explanationFinalAnswerMismatch(q.stem, q.options, q.correct_answer, q.explanation);
    if (r.mismatch) {
      warnings.push({
        questionIndex: idx + 1,
        field: "explanation",
        issue: `CRITICAL: explanation contradicts the marked answer "${q.correct_answer}" — it never states the correct value "${r.expected}". Review before publishing.`,
        autoFixed: false,
      });
    }
  });
  return warnings;
}

// ─── Per-option rationale integrity ────────────────────────────────────────

/**
 * Validate the verifier's per-option rationale array against the actual
 * options it claims to describe. Catches the common drift modes:
 *   - rationale.option text doesn't match any option (verifier rewrote it)
 *   - more or fewer than one isCorrect=true row
 *   - the isCorrect=true row's option text doesn't match correct_answer
 *   - duplicate or out-of-order option entries
 *
 * On any structural issue, drops the entire option_rationales for that
 * question and records a warning. We'd rather omit than ship a malformed
 * attribution that the marker would mis-display.
 */
export function validateOptionRationales(
  questions: QuizResult["questions"],
  approvedSeedIds: Set<number>,
): { questions: QuizResult["questions"]; warnings: PipelineWarning[] } {
  const warnings: PipelineWarning[] = [];
  const corrected = questions.map((q, idx) => {
    if (!q.option_rationales) return q;
    const rats = q.option_rationales;
    if (rats.length !== 4) {
      warnings.push({
        questionIndex: idx + 1,
        field: "explanation",
        issue: `option_rationales must have exactly 4 rows; got ${rats.length}. Dropping rationales.`,
        autoFixed: false,
      });
      return { ...q, option_rationales: undefined };
    }
    // Reorder rationales to match options[] order; drop the array if any
    // option text is missing from the rationale list.
    const reordered: typeof rats = [];
    const usedRationaleIdx = new Set<number>();
    for (const opt of q.options) {
      const matchIdx = rats.findIndex(
        (r, i) => !usedRationaleIdx.has(i) && r.option.trim() === opt.trim(),
      );
      if (matchIdx === -1) {
        warnings.push({
          questionIndex: idx + 1,
          field: "explanation",
          issue: `option_rationales does not cover option "${opt.slice(0, 40)}…". Dropping rationales.`,
          autoFixed: false,
        });
        return { ...q, option_rationales: undefined };
      }
      usedRationaleIdx.add(matchIdx);
      reordered.push(rats[matchIdx]);
    }
    const correctRows = reordered.filter((r) => r.isCorrect);
    if (correctRows.length !== 1) {
      warnings.push({
        questionIndex: idx + 1,
        field: "explanation",
        issue: `Expected exactly one isCorrect=true rationale; got ${correctRows.length}. Dropping rationales.`,
        autoFixed: false,
      });
      return { ...q, option_rationales: undefined };
    }
    if (correctRows[0].option.trim() !== q.correct_answer.trim()) {
      warnings.push({
        questionIndex: idx + 1,
        field: "explanation",
        issue: `isCorrect rationale labels "${correctRows[0].option.slice(0, 40)}…" but correct_answer is "${q.correct_answer.slice(0, 40)}…". Dropping rationales.`,
        autoFixed: false,
      });
      return { ...q, option_rationales: undefined };
    }
    // Strip misconception ids that aren't on the approved list — the verifier
    // sometimes hallucinates ids when the seed list is empty or short. Better
    // to lose attribution than ship a wrong link.
    const cleaned = reordered.map((r) => {
      if (r.misconceptionId == null) return r;
      if (approvedSeedIds.size === 0 || !approvedSeedIds.has(r.misconceptionId)) {
        return { ...r, misconceptionId: null };
      }
      return r;
    });
    return { ...q, option_rationales: cleaned };
  });
  return { questions: corrected, warnings };
}

// ─── 3-way disagreement protocol ───────────────────────────────────────────

export interface BlockedQuestion {
  /** 1-based index in the original generation request. */
  originalIndex: number;
  /** Human-readable reason for blocking. */
  reason: string;
  /** The question that was blocked (so the caller can re-roll or surface to a tutor). */
  rejected: QuizResult["questions"][number];
  /** What each voice said, for telemetry. */
  votes: {
    maker: string;
    verifier: string;
    prover: string | null;
  };
}

/**
 * Three-way vote between the maker (initial answer), the verifier (post-fix
 * answer) and the deterministic prover (math validator). The principle: do
 * not silently coerce — when we cannot confidently identify the correct
 * answer, BLOCK the question rather than ship a wrong key.
 *
 * Decision matrix:
 *   prover available + prover == verifier  → ship (high confidence)
 *   prover available + prover != verifier  → BLOCK (both LLMs may be wrong)
 *   prover unavailable + verifier == maker → ship (LLM consensus, no prover)
 *   prover unavailable + verifier != maker → ship (verifier did its job),
 *     but emit an info warning so the tutor knows the maker disagreed.
 *
 * Plus: any question that arrived with an UNFIXED critical answer-match
 * warning (i.e. validateAndCorrectMcqAnswers fell back to options[0]) is
 * blocked outright — those are the silent-coerce errors that prompted this
 * whole change.
 */
export function applyDisagreementProtocol(
  drafts: DraftQuiz["questions"],
  verified: QuizResult["questions"],
  upstreamWarnings: PipelineWarning[],
): { questions: QuizResult["questions"]; warnings: PipelineWarning[]; blocked: BlockedQuestion[] } {
  const warnings: PipelineWarning[] = [];
  const blocked: BlockedQuestion[] = [];
  const kept: QuizResult["questions"] = [];

  // Index unfixed CRITICAL answer-key warnings by question index so we can
  // block them en bloc without re-deriving the heuristic.
  const criticalUnfixedByIndex = new Set<number>();
  for (const w of upstreamWarnings) {
    if (w.autoFixed === false && /CRITICAL/i.test(w.issue)) {
      criticalUnfixedByIndex.add(w.questionIndex);
    }
  }

  for (let i = 0; i < verified.length; i++) {
    const v = verified[i];
    const draft = drafts[i];
    const oneBased = i + 1;

    // Rule 1: any unfixed CRITICAL warning blocks. The validator already
    // tried letter-mapping, substring-matching, and math-prover — if it
    // still couldn't snap, we have no trustworthy answer.
    if (criticalUnfixedByIndex.has(oneBased)) {
      blocked.push({
        originalIndex: oneBased,
        reason: "Question failed integrity checks (unmatchable answer key or malformed options) after letter/numeric/math recovery.",
        rejected: v,
        votes: { maker: draft?.correct_answer ?? "(no draft)", verifier: v.correct_answer, prover: null },
      });
      continue;
    }

    // Rule 2: deterministic prover is the tiebreaker. Compare by numeric
    // value before blocking — "2" vs "2.0" is agreement, not disagreement,
    // and a false block here burns a re-roll pass for nothing.
    const prove = validateMathQuestion(v.stem, v.options, v.correct_answer);
    const proverAnswer = prove.verifiable && prove.matchedOption ? prove.matchedOption : null;

    if (
      proverAnswer &&
      proverAnswer.trim() !== v.correct_answer.trim() &&
      !numericallyEquivalent(proverAnswer, v.correct_answer)
    ) {
      blocked.push({
        originalIndex: oneBased,
        reason: `Deterministic prover disagreed with verifier (prover="${proverAnswer}", verifier="${v.correct_answer}", pattern=${prove.pattern}). Both LLMs may be wrong.`,
        rejected: v,
        votes: {
          maker: draft?.correct_answer ?? "(no draft)",
          verifier: v.correct_answer,
          prover: proverAnswer,
        },
      });
      continue;
    }

    // Rule 2b: the explanation's stated answer must agree with the marked
    // option. For complex-number questions the check is high-confidence, so a
    // worked explanation that never states the correct value is BLOCKED rather
    // than teaching the student the wrong working. For plain numeric questions
    // the heuristic is looser (equivalent forms exist), so we only warn.
    if (v.explanation) {
      const exMismatch = explanationFinalAnswerMismatch(v.stem, v.options, v.correct_answer, v.explanation);
      if (exMismatch.mismatch && exMismatch.complex) {
        blocked.push({
          originalIndex: oneBased,
          reason: `Explanation contradicts the marked answer (marked="${v.correct_answer}", explanation never states the correct value "${exMismatch.expected}").`,
          rejected: v,
          votes: {
            maker: draft?.correct_answer ?? "(no draft)",
            verifier: v.correct_answer,
            prover: proverAnswer,
          },
        });
        continue;
      }
      if (exMismatch.mismatch) {
        warnings.push({
          questionIndex: oneBased,
          field: "explanation",
          issue: `Explanation may contradict the marked answer "${v.correct_answer}" — the value "${exMismatch.expected}" does not appear in the worked steps. Please review before publishing.`,
          autoFixed: false,
        });
      }
    }

    // Rule 3: when verifier overrode the maker, surface that for tutor visibility.
    if (draft && draft.correct_answer.trim() !== v.correct_answer.trim()) {
      warnings.push({
        questionIndex: oneBased,
        field: "correct_answer",
        issue: `Verifier disagreed with maker (maker="${draft.correct_answer}", verifier="${v.correct_answer}"${proverAnswer ? `, prover="${proverAnswer}" agrees with verifier` : ", no prover available"}). Shipping verifier's answer.`,
        autoFixed: true,
      });
    }

    kept.push(v);
  }

  return { questions: kept, warnings, blocked };
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
  const blueprintRule = context.blueprint
    ? `\n- A QUESTION BLUEPRINT is supplied in the user message. Produce one question per row, in row order, matching each row's role, anchor, difficulty, and (for probe rows) the cited misconception verbatim.`
    : "";
  return `You are the SOMA question maker. Generate exactly ${questionCount} MCQ questions.

STRICT SCOPE: subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}.
Difficulty mix target: easy=${distribution.easy}%, medium=${distribution.medium}%, hard=${distribution.hard}%.

Requirements:${blueprintRule}
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
  const blueprintBlock = context.blueprint
    ? "\n\n" + renderBlueprintForMaker(context.blueprint, context.examinerSeeds)
    : "";
  return `Topic: ${context.topic}${catalogueBlock(context)}${seedsBlock}${blueprintBlock}\n${context.copilotPrompt || ""}\n${context.supportingDocText || ""}`;
}

function buildVerifierSystemPrompt(context: SomaGenerationContext): string {
  const blueprintRule = context.blueprint
    ? `\n   - Use the supplied blueprint row (matched by question index) to attribute distractors to misconceptions: when a row has role="misconception_probe" with targetMisconceptionId, the wrong option that reproduces that misconception's typical error must carry option_rationales[k].misconceptionId = targetMisconceptionId.`
    : "";
  const seedAttributionRule = context.examinerSeeds && context.examinerSeeds.length > 0
    ? `\n   - For any distractor that visibly reproduces one of the supplied examiner-misconception seeds, set option_rationales[k].misconceptionId to that seed's id. Use null when no seed matches — never invent ids that aren't on the supplied list.`
    : "";
  return `You are the SOMA question verifier. For EACH question you receive:

1. CHECK that correct_answer is objectively correct and in-scope for subject=${context.subject}, syllabus=${context.syllabus}, level=${context.level}, topic=${context.topic}${context.subtopic ? `, subtopic=${context.subtopic}` : ""}. The 4 options must be distinct and the question solvable.
2. FIX any error you find:
   - If correct_answer is wrong but a correct option exists, change correct_answer to that option.
   - If no option is correct, rewrite one option so it is correct and set correct_answer to it.
   - If the stem is ambiguous or unsolvable, rewrite the stem minimally to make a clear, correct question.
3. Once the answer is correct, WRITE the explanation field in this voice:

${SOMA_TUTOR_VOICE}

4. PER-OPTION RATIONALES — for every question, also fill option_rationales: an array of exactly 4 entries, one per option in the same order as options[].
   - Each entry: { option (verbatim option text), isCorrect (true for the correct answer, false for distractors), rationale (1-2 sentences in the Soma tutor voice; for distractors, name the specific reasoning step the student got wrong), misconceptionId (number or null) }
   - Exactly one entry must have isCorrect=true.${blueprintRule}${seedAttributionRule}
   - When no seed matches a distractor, set misconceptionId=null. Never reuse the same misconceptionId on more than one distractor in the same question unless the seed truly explains both.

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
  runBlueprintPlanner,
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
/**
 * Public entry. Runs one pipeline pass, then — if the disagreement
 * protocol blocked any questions — re-rolls the missing slots up to
 * `maxRerollAttempts` times so the assignment ships at full length.
 *
 * Re-rolls inherit the original context (subject, syllabus, level, seeds,
 * etc.) but generate a fresh blueprint for just the shortfall count. They
 * call back into generateAuditedQuiz with `_disableReroll` set so the
 * inner pass returns whatever it produced and we control the loop here.
 */
export async function generateAuditedQuiz(input: SomaGenerationContext | string): Promise<AuditedQuizResult> {
  const overallStart = Date.now();
  const context: SomaGenerationContext = typeof input === "string"
    ? { topic: input, subject: "Mathematics", syllabus: "IEB", level: "Grade 6-12" }
    : input;

  const initial = await runOnePassQuiz(context, overallStart);

  // Re-roll disabled (we're inside a re-roll already) or first pass
  // shipped a full quiz → return as-is.
  if (context._disableReroll || initial.blockedQuestions.length === 0) {
    return {
      ...initial,
      telemetry: {
        ...initial.telemetry,
        rerollAttempts: initial.telemetry.rerollAttempts ?? 0,
        recoveredCount: 0,
      },
    };
  }

  const maxAttempts = Math.max(0, context.maxRerollAttempts ?? 2);
  if (maxAttempts === 0) return initial;

  const requestedCount = Math.max(1, Math.min(50, context.questionCount ?? 8));
  const initialBlockCount = initial.blockedQuestions.length;
  let kept = [...initial.questions];
  let warnings = [...initial.warnings];
  let lastTelemetry = initial.telemetry;
  let lastBlueprint = initial.blueprint;
  let stillBlocked = initial.blockedQuestions;
  let attempt = 0;

  while (stillBlocked.length > 0 && attempt < maxAttempts) {
    attempt += 1;
    const rerollContext: SomaGenerationContext = {
      ...context,
      questionCount: stillBlocked.length,
      blueprint: undefined, // fresh plan for the shortfall slots
      _disableReroll: true,
    };
    let reroll: AuditedQuizResult;
    try {
      reroll = await generateAuditedQuiz(rerollContext);
    } catch (err: any) {
      warnings.push({
        questionIndex: 0,
        field: "overall",
        issue: `Re-roll attempt ${attempt} failed (${err?.message ?? String(err)}). Keeping ${kept.length}/${requestedCount} questions.`,
        autoFixed: false,
      });
      break;
    }
    kept = [...kept, ...reroll.questions];
    warnings = [
      ...warnings,
      ...reroll.warnings.map((w) => ({ ...w, issue: `[reroll #${attempt}] ${w.issue}` })),
    ];
    lastTelemetry = reroll.telemetry;
    if (reroll.blueprint) {
      const baseIdx = lastBlueprint?.rows.length ?? 0;
      const appended = reroll.blueprint.rows.map((r, i) => ({ ...r, questionIndex: baseIdx + i + 1 }));
      lastBlueprint = lastBlueprint
        ? { rows: [...lastBlueprint.rows, ...appended] }
        : { rows: appended };
    }
    stillBlocked = reroll.blockedQuestions;
  }

  const recoveredCount = initialBlockCount - stillBlocked.length;
  if (stillBlocked.length > 0) {
    warnings.push({
      questionIndex: 0,
      field: "overall",
      issue: `${stillBlocked.length} question(s) remained blocked after ${attempt} re-roll attempt(s); shipping ${kept.length}/${requestedCount}. Tutor review required for the missing slots.`,
      autoFixed: false,
    });
  }

  return {
    questions: kept,
    warnings,
    telemetry: {
      ...lastTelemetry,
      rerollAttempts: attempt,
      recoveredCount,
      totalDurationMs: Date.now() - overallStart,
    },
    seedMisconceptionIds: initial.seedMisconceptionIds,
    blueprint: lastBlueprint,
    blockedQuestions: stillBlocked,
  };
}

/**
 * Single pipeline pass: planner → maker → verifier → guards →
 * disagreement protocol. Returns whatever survived the protocol on this
 * pass; the outer wrapper decides whether to re-roll for shortfall.
 */
async function runOnePassQuiz(
  context: SomaGenerationContext,
  overallStart: number,
): Promise<AuditedQuizResult> {
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
    // Stitch together the per-batch blueprints so the caller receives one
    // plan covering the whole quiz. Each batch already has rows numbered
    // from 1; we re-number sequentially across the full questionCount.
    const stitchedRows: Blueprint["rows"] = [];
    for (const batch of batchResults) {
      if (!batch.blueprint) continue;
      for (const row of batch.blueprint.rows) {
        stitchedRows.push({ ...row, questionIndex: stitchedRows.length + 1 });
      }
    }
    const stitchedBlueprint: Blueprint | null = stitchedRows.length > 0 ? { rows: stitchedRows } : null;
    // Carry blocked questions from each batch into the merged result so
    // callers see the full picture, not just the surviving questions.
    const allBlocked: BlockedQuestion[] = [];
    let runningOffset = 0;
    for (const batch of batchResults) {
      for (const b of batch.blockedQuestions) {
        allBlocked.push({ ...b, originalIndex: b.originalIndex + runningOffset });
      }
      runningOffset += batch.questions.length + batch.blockedQuestions.length;
    }
    return {
      questions: finalValidated.questions,
      warnings: [...allWarnings, ...finalValidated.warnings],
      telemetry: { ...lastTelemetry, totalDurationMs: Date.now() - overallStart },
      seedMisconceptionIds: (context.examinerSeeds ?? []).map((s) => s.id),
      blueprint: stitchedBlueprint,
      blockedQuestions: allBlocked,
    };
  }

  // ── STAGE 0: BLUEPRINT PLANNER ──────────────────────────────────────────
  // Build the per-question intent grid before any maker call so coverage
  // and probe rows are explicit, traceable, and aligned with the catalogue.
  // If the planner returns null (no anchors + no seeds, or every provider
  // failed), we keep the legacy improvised path.
  const planner = pipelineStages.runBlueprintPlanner;
  let blueprint: Blueprint | null = context.blueprint ?? null;
  if (!blueprint && planner) {
    try {
      blueprint = await planner({
        questionCount,
        purpose: context.purpose ?? inferPurposeFromPrompt(context.copilotPrompt),
        difficultyDistribution: distribution,
        catalogueContext: context.catalogueContext,
        examinerSeeds: context.examinerSeeds,
        topic: context.topic,
        subtopic: context.subtopic,
        subject: context.subject,
        syllabus: context.syllabus,
        level: context.level,
        tutorPrompt: context.copilotPrompt,
      });
    } catch (err: any) {
      console.warn(`[SOMA_PIPELINE] Blueprint planner failed (${err?.message || "unknown"}); proceeding without plan.`);
      blueprint = null;
    }
  }
  const contextWithPlan: SomaGenerationContext = blueprint ? { ...context, blueprint } : context;

  // ── STAGE 1: MAKER ──────────────────────────────────────────────────────
  let draft: DraftQuiz;
  let makerModel: string;
  let claudeMadeTheQuiz = true;
  try {
    draft = await pipelineStages.runClaudeMakerSimple(contextWithPlan, questionCount, distribution);
    makerModel = "anthropic/claude-sonnet-4-6";
  } catch (err: any) {
    console.warn(`[SOMA_PIPELINE] Claude maker failed (${err?.message || "unknown"}); falling back to ChatGPT maker.`);
    draft = await pipelineStages.runOpenAIMakerSimple(contextWithPlan, questionCount, distribution);
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
      verified = await pipelineStages.runOpenAIVerifier(draft.questions, contextWithPlan);
      checkerModel = "openai/gpt-4o";
    } catch (err: any) {
      console.warn(`[SOMA_PIPELINE] ChatGPT verifier failed (${err?.message || "unknown"}); falling back to Gemini verifier.`);
      verified = await pipelineStages.runGeminiVerifier(draft.questions, contextWithPlan);
      checkerModel = "google/gemini-2.5-flash";
    }
  } else {
    verified = await pipelineStages.runGeminiVerifier(draft.questions, contextWithPlan);
    checkerModel = "google/gemini-2.5-flash";
  }

  // ── STAGE 3: Deterministic guards ───────────────────────────────────────
  const guarded = applyDeterministicIntegrityGuards(verified.questions);
  const validated = validateAndCorrectMcqAnswers(guarded.questions);
  const mathCheck = applyMathValidatorCorrections(validated.questions);

  // ── STAGE 3a: Per-option rationale integrity ───────────────────────────
  // Drop malformed rationale arrays before persistence; never ship a
  // mis-aligned attribution that the marker would surface to a student.
  const approvedSeedIds = new Set((context.examinerSeeds ?? []).map((s) => s.id));
  const rationaleChecked = validateOptionRationales(mathCheck.questions, approvedSeedIds);

  // ── STAGE 4: 3-way disagreement protocol ───────────────────────────────
  // Vote between maker, verifier, and deterministic prover. Block any
  // question we cannot confidently mark correct; never silently coerce.
  const upstreamWarnings: PipelineWarning[] = [
    ...verified.warnings,
    ...guarded.warnings,
    ...validated.warnings,
    ...mathCheck.warnings,
    ...rationaleChecked.warnings,
  ];
  const protocol = applyDisagreementProtocol(draft.questions, rationaleChecked.questions, upstreamWarnings);
  for (const b of protocol.blocked) {
    upstreamWarnings.push({
      questionIndex: b.originalIndex,
      field: "correct_answer",
      issue: `BLOCKED — ${b.reason} maker="${b.votes.maker}", verifier="${b.votes.verifier}"${b.votes.prover ? `, prover="${b.votes.prover}"` : ""}.`,
      autoFixed: false,
    });
  }

  // ── STAGE 5: post-generation difficulty drift check (informational) ──────
  // The requested easy/medium/hard mix is only ever a hint to the maker, so
  // the final set can drift. Compare the realised distribution to the target
  // and surface ONE summary warning for the tutor. Never blocks.
  const finalWarnings = [...upstreamWarnings, ...protocol.warnings];
  const driftWarning = computeDifficultyDriftWarning(protocol.questions, distribution);
  if (driftWarning) finalWarnings.push(driftWarning);

  return {
    questions: protocol.questions,
    warnings: finalWarnings,
    telemetry: {
      makerModel,
      checkerModel,
      polishModel: null,
      totalDurationMs: Date.now() - overallStart,
    },
    seedMisconceptionIds: (context.examinerSeeds ?? []).map((s) => s.id),
    blueprint,
    blockedQuestions: protocol.blocked,
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
    const explanationWarnings = flagExplanationContradictions(mathCheck.questions);
    return {
      questions: mathCheck.questions,
      warnings: [...verified.warnings, ...guarded.warnings, ...validated.warnings, ...mathCheck.warnings, ...explanationWarnings],
      verifierModel: "openai/gpt-4o",
    };
  } catch (err: any) {
    console.warn(`[COPILOT_AUDIT] ChatGPT verifier failed (${err?.message || "unknown"}); falling back to Gemini.`);
    try {
      const verified = await pipelineStages.runGeminiVerifier(draftQuestions, context);
      const guarded = applyDeterministicIntegrityGuards(verified.questions);
      const validated = validateAndCorrectMcqAnswers(guarded.questions);
      const mathCheck = applyMathValidatorCorrections(validated.questions);
      const explanationWarnings = flagExplanationContradictions(mathCheck.questions);
      return {
        questions: mathCheck.questions,
        warnings: [...verified.warnings, ...guarded.warnings, ...validated.warnings, ...mathCheck.warnings, ...explanationWarnings],
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
