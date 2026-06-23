import { z } from "zod";

export const pdfMarkingModeSchema = z.enum(["manual", "dual_ai"]);
export type PdfMarkingMode = z.infer<typeof pdfMarkingModeSchema>;
export const pdfPreparationStatusSchema = z.enum(["not_started", "queued", "processing", "needs_review", "ready", "failed"]);
export const aiMarkingStatusSchema = z.enum(["queued", "processing", "blocked_setup", "needs_tutor_review", "ready_for_approval", "approved", "failed_retryable", "failed_terminal", "superseded", "manual_override"]);
export const annotationTypeSchema = z.enum(["tick", "cross", "omission", "comment", "uncertain"]);
export const basisPointSchema = z.number().int().min(0).max(10000);

export const pdfRubricItemSchema = z.object({
  rubricItemId: z.string().min(1).max(120), sequence: z.number().int().positive(), description: z.string().min(1).max(2000), maximumMarks: z.number().int().nonnegative(),
  markType: z.enum(["method", "accuracy", "independent", "communication"]), dependencies: z.array(z.string().min(1).max(120)).default([]), errorCarriedForwardAllowed: z.boolean().default(false), unitsRequired: z.boolean().default(false),
  tolerance: z.object({ type: z.enum(["absolute", "relative"]), value: z.number().nonnegative() }).optional(),
});
export const pdfRubricQuestionSchema = z.object({
  questionId: z.string().min(1).max(120), label: z.string().min(1).max(80), prompt: z.string().max(5000), pageReferences: z.array(z.number().int().positive()).default([]), maximumMarks: z.number().int().nonnegative(),
  answerType: z.enum(["numeric", "algebraic", "short_text", "extended_text", "diagram"]), syllabusTags: z.array(z.string().max(120)).default([]), acceptedAlternatives: z.array(z.string().max(1000)).default([]), rubricItems: z.array(pdfRubricItemSchema).min(1),
});
export const pdfRubricSchema = z.object({ assessmentTitle: z.string().min(1).max(300), totalMarks: z.number().int().nonnegative(), questions: z.array(pdfRubricQuestionSchema).min(1) }).superRefine((rubric, ctx) => {
  const ids = new Set<string>(); let total = 0;
  rubric.questions.forEach((q, qi) => { const qTotal = q.rubricItems.reduce((s, i) => s + i.maximumMarks, 0); total += q.maximumMarks; if (qTotal !== q.maximumMarks) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["questions", qi, "maximumMarks"], message: "Rubric item marks must sum to question maximum" }); q.rubricItems.forEach((i, ii) => { if (ids.has(i.rubricItemId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["questions", qi, "rubricItems", ii, "rubricItemId"], message: "rubricItemId must be unique" }); ids.add(i.rubricItemId); }); });
  if (total !== rubric.totalMarks) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["totalMarks"], message: "Question maximums must sum to totalMarks" });
});
export type PdfRubric = z.infer<typeof pdfRubricSchema>;

export const pdfEvidenceSchema = z.object({ pageNumber: z.number().int().positive(), xBp: basisPointSchema, yBp: basisPointSchema, widthBp: basisPointSchema, heightBp: basisPointSchema, transcribedEvidence: z.string().max(1000) });
export const markerDecisionSchema = z.object({ decisionId: z.string().min(1).max(120), questionLabel: z.string().min(1).max(80), rubricItemId: z.string().min(1).max(120), verdict: z.enum(["correct", "incorrect", "omitted", "unreadable", "uncertain", "not_attempted"]), awardedMarks: z.number().int().nonnegative(), maximumMarks: z.number().int().nonnegative(), confidencePct: z.number().int().min(0).max(100), evidence: z.array(pdfEvidenceSchema), explanation: z.string().max(1500), annotation: z.enum(["tick", "cross", "omission", "comment", "uncertain", "none"]) });
export const markerResultSchema = z.object({ decisions: z.array(markerDecisionSchema), summary: z.string().max(3000).optional() });
export const verificationDecisionSchema = z.object({ targetDecisionId: z.string().min(1).max(120), verdict: z.enum(["accept", "reject", "uncertain"]), correctedAwardedMarks: z.number().int().nonnegative().optional(), rationale: z.string().max(1500), evidence: z.array(pdfEvidenceSchema).default([]) });
export const verificationResultSchema = z.object({ decisions: z.array(verificationDecisionSchema) });
export const reconciledResultSchema = z.object({ accepted: z.array(markerDecisionSchema), reviewItems: z.array(z.object({ questionLabel: z.string(), rubricItemId: z.string(), reasonCode: z.string() })), proposedScore: z.number().int().nonnegative(), maxScore: z.number().int().nonnegative(), requiresTutorReview: z.boolean() });
export const pdfAnnotationSchema = z.object({ pageNumber: z.number().int().positive(), annotationType: annotationTypeSchema, xBp: basisPointSchema, yBp: basisPointSchema, widthBp: basisPointSchema, heightBp: basisPointSchema, questionLabel: z.string().max(80), rubricItemId: z.string().max(120).nullable().optional(), awardedMarks: z.number().int().nonnegative(), maxMarks: z.number().int().nonnegative(), explanation: z.string().max(1500), source: z.enum(["reconciled", "tutor"]), status: z.enum(["proposed", "approved", "rejected"]) });
export const tutorReviewUpdateSchema = z.object({ resolutionStatus: z.enum(["accepted", "overridden", "rejected"]), resolvedMarks: z.number().int().nonnegative().nullable().optional(), resolutionNote: z.string().max(2000).nullable().optional() });
export const studentSafeSubmissionStatusSchema = z.object({ id: z.number().int(), filename: z.string(), status: z.string(), score: z.number().nullable(), maxScore: z.number().nullable(), feedback: z.string().nullable(), aiMarkingStatus: aiMarkingStatusSchema.nullable().optional(), hasAnnotatedPdf: z.boolean().default(false), createdAt: z.union([z.string(), z.date()]), markedAt: z.union([z.string(), z.date()]).nullable() });

export function validateMarkerResultAgainstRubric(result: z.infer<typeof markerResultSchema>, rubric: PdfRubric): void {
  const items = new Map(rubric.questions.flatMap(q => q.rubricItems.map(i => [i.rubricItemId, { item: i, question: q }] as const)));
  for (const d of result.decisions) { const found = items.get(d.rubricItemId); if (!found) throw new Error(`Unknown rubric item: ${d.rubricItemId}`); if (d.awardedMarks > found.item.maximumMarks || d.maximumMarks !== found.item.maximumMarks) throw new Error(`Invalid mark bounds for ${d.rubricItemId}`); if (!d.evidence.length && !["omitted", "not_attempted"].includes(d.verdict)) throw new Error(`Missing evidence for ${d.rubricItemId}`); }
}
