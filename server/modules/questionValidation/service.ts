import { graphQuestionSpecSchema, type DraftQuestion, type SomaQuestion } from "@shared/schema";
import type { z } from "zod";
import { assessTopicScope, resolveReviewStatus } from "../../services/questionScope";
import { validateQuestionQuality } from "../../services/questionQuality";
import { explanationFinalAnswerMismatch } from "../../services/mathValidator";
import { detectGraphIntent, validateWithAutoFix } from "../../services/cambridgeGraphEngine";

export const MAX_QUESTIONS_PER_QUIZ = 15;

export type ReviewStatus = "approved" | "needs_review" | "auto_blocked";
export type PublishValidationResult = { reviewStatusByIndex: ReviewStatus[] };
export class QuestionValidationError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}

export function repairGraphSpec(raw: unknown): z.infer<typeof graphQuestionSpecSchema> | null {
  const parsed = graphQuestionSpecSchema.safeParse(raw);
  if (!parsed.success) return null;
  const inferredIntent = detectGraphIntent({ prompt: parsed.data.label ?? parsed.data.graphKind ?? "Graph", subject: parsed.data.subjectPreset ?? "mathematics", level: parsed.data.level ?? "", syllabusCode: parsed.data.subjectCode, topic: parsed.data.graphKind });
  const checked = validateWithAutoFix(parsed.data, inferredIntent);
  return {
    ...checked.spec,
    auditNotes: [...(checked.spec.auditNotes ?? []), ...inferredIntent.reasons, ...checked.validation.audit, ...checked.appliedFixes.map((fix) => `Auto-fix: ${fix}`)],
    graphFamily: inferredIntent.family,
    sourceContext: { ...(checked.spec.sourceContext ?? {}), commandWords: inferredIntent.skills, skillType: inferredIntent.skills.join(","), intent: inferredIntent.figureMode },
    validationTargets: { ...(checked.spec.validationTargets ?? {}), requireFrequencyDensityLabel: inferredIntent.family === "histogram_frequency_density", requireErrorBars: inferredIntent.skills.includes("use_error_bars"), requireBestFit: inferredIntent.family === "scatter_best_fit" },
  };
}

export function summarizeReviewStatuses(questions: Array<{ reviewStatus?: string | null }>): { total: number; servable: number; needsReview: number; autoBlocked: number } {
  let servable = 0; let needsReview = 0; let autoBlocked = 0;
  for (const q of questions) { const status = q.reviewStatus ?? "approved"; if (status === "auto_blocked") autoBlocked += 1; else if (status === "needs_review") needsReview += 1; else servable += 1; }
  return { total: questions.length, servable, needsReview, autoBlocked };
}

export function validateDraftForPublish(draft: DraftQuestion[], publishAllowedTopics: unknown[]): PublishValidationResult {
  const reviewStatusByIndex: ReviewStatus[] = [];
  for (let i = 0; i < draft.length; i++) {
    const q = draft[i];
    if (!q.stem) throw new QuestionValidationError(400, `Question "${String(q.stem || "").slice(0, 40)}" is missing required fields`);
    if (q.questionType === "structured") {
      if (!q.markScheme || !String(q.markScheme).trim()) throw new QuestionValidationError(400, `Structured question "${String(q.stem).slice(0, 40)}" is missing a mark scheme`);
      reviewStatusByIndex[i] = "approved";
      continue;
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) throw new QuestionValidationError(400, `Question "${String(q.stem || "").slice(0, 40)}" is missing required fields`);
    if (q.questionType === "graph" && q.graphSpec) {
      const check = repairGraphSpec(q.graphSpec);
      if (!check) throw new QuestionValidationError(400, "A graph question has an invalid graph spec");
    }
    const quality = validateQuestionQuality({ stem: q.stem, options: q.options, correct_answer: q.correctAnswer, explanation: q.explanation ?? undefined, difficulty_tag: q.difficultyTag ?? undefined });
    if (quality.reviewStatus === "auto_blocked") throw new QuestionValidationError(422, `Cannot publish: question ${i + 1} failed quality checks (${quality.blocking.join("; ")}). Fix or regenerate it before publishing.`, { questionIndex: i + 1, blocking: quality.blocking });
    const scope = assessTopicScope(q.topicTag, q.subtopicTag, publishAllowedTopics as any);
    reviewStatusByIndex[i] = resolveReviewStatus({ baseStatus: quality.reviewStatus, scope }).reviewStatus;
  }
  for (let i = 0; i < draft.length; i++) {
    const q = draft[i];
    if (!q.explanation || !q.correctAnswer) continue;
    const exMismatch = explanationFinalAnswerMismatch(q.stem, q.options, q.correctAnswer, q.explanation);
    if (exMismatch.mismatch && exMismatch.complex) throw new QuestionValidationError(422, `Cannot publish: question ${i + 1} has an explanation that contradicts its marked answer "${q.correctAnswer}" (the correct value "${exMismatch.expected}" never appears in the worked steps). Fix the explanation or answer key, then publish again.`, { questionIndex: i + 1 });
  }
  return { reviewStatusByIndex };
}

export function mapDraftToInsertQuestions(quizId: number, draft: DraftQuestion[], reviewStatusByIndex: ReviewStatus[]) {
  return draft.map((q, idx) => ({
    quizId,
    stem: q.stem,
    options: q.options,
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    marks: q.marks,
    questionType: q.questionType,
    graphSpec: (q.graphSpec ?? null) as any,
    markScheme: q.markScheme ?? null,
    reviewStatus: reviewStatusByIndex[idx] ?? "approved",
    topicTag: q.topicTag ?? null,
    subtopicTag: q.subtopicTag ?? null,
    difficultyTag: q.difficultyTag ?? null,
    subtopicId: q.subtopicId ?? null,
    learningRequirementId: q.learningRequirementId ?? null,
    targetMisconceptionIds: q.targetMisconceptionIds ?? null,
    commandWord: q.commandWord ?? null,
    assessmentObjective: q.assessmentObjective ?? null,
    optionRationales: q.optionRationales ?? null,
    generationMeta: (q as DraftQuestion & { generationMeta?: unknown }).generationMeta ?? null,
  }));
}

export function sanitizeQuestionForPreSubmission(q: SomaQuestion) {
  return { id: q.id, quizId: q.quizId, stem: q.stem, options: q.options, marks: q.marks, questionType: q.questionType, graphSpec: q.graphSpec };
}
