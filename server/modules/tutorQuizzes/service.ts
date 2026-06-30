import { storage } from "../../storage";
import { normalizeQuizSyllabusForWrite } from "../../services/syllabusNormalizer";
import { validateQuestionQuality } from "../../services/questionQuality";
import { answersMatch, effectiveCorrectAnswer } from "../../services/mathValidator";
import { collectQuizStoragePaths, purgeStorageObjects } from "../fileStorageAccess/service";
import type { z } from "zod";
import type { reviewPatchSchema } from "./validators";

export class TutorQuizError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function assertOwnedQuiz(quizId: number, tutorId: string, notFoundAs403 = true) {
  const quiz = await storage.getSomaQuiz(quizId);
  if (!quiz) throw new TutorQuizError(notFoundAs403 ? 403 : 404, "Quiz not found");
  if (quiz.authorId !== tutorId) throw new TutorQuizError(403, "Access denied");
  return quiz;
}

function normalizeQuizModeFields(format: string, quizMode: unknown, questionCount: unknown, structuredCount: unknown) {
  const mode = ["mcq", "structured", "hybrid"].includes(String(quizMode)) ? String(quizMode) : "mcq";
  const requestedCount = Number(questionCount);
  const count = Number.isFinite(requestedCount) && requestedCount > 0 ? Math.max(1, Math.min(50, Math.floor(requestedCount))) : 10;
  const requestedStructured = Number(structuredCount);
  const structured = mode === "structured" ? count : mode === "hybrid" ? Math.max(0, Math.min(count, Number.isFinite(requestedStructured) ? Math.floor(requestedStructured) : Math.ceil(count / 2))) : 0;
  return { mode: format === "pdf" ? "pdf" : mode, count, structured };
}

export async function listOwned(tutorId: string) { const quizzes = await storage.getSomaQuizzesByAuthor(tutorId); return quizzes.filter((q) => !q.isArchived); }
export async function clone(quizId: number, tutorId: string) { const source = await storage.getSomaQuiz(quizId); if (!source || source.authorId !== tutorId) throw new TutorQuizError(404, "Quiz not found"); const cloned = await storage.cloneSomaQuiz(quizId, tutorId); if (!cloned) throw new TutorQuizError(404, "Quiz not found"); return cloned; }
export async function create(tutorId: string, body: any) {
  const { title, syllabus, level, subject, topic, topics, timeLimitMinutes, format, quizMode, questionCount, structuredCount } = body;
  if (!title) throw new TutorQuizError(400, "title is required");
  if (!timeLimitMinutes || isNaN(Number(timeLimitMinutes))) throw new TutorQuizError(400, "timeLimitMinutes is required and must be a number");
  const normalizedFormat = format === "pdf" ? "pdf" : "mcq";
  const { mode, count, structured } = normalizeQuizModeFields(normalizedFormat, quizMode, questionCount, structuredCount);
  const cleanTopics = Array.isArray(topics) ? topics.map((t: unknown) => String(t || "").trim()).filter(Boolean) : [];
  return storage.createSomaQuiz({ title, topic: cleanTopics[0] || topic || title, topics: cleanTopics, syllabus: normalizeQuizSyllabusForWrite(syllabus), level: level ?? null, subject: subject ?? null, timeLimitMinutes: Number(timeLimitMinutes), authorId: tutorId, format: normalizedFormat, quizMode: mode, questionCount: count, structuredCount: structured, status: "published" });
}
export async function detail(quizId: number, tutorId: string) { const quiz = await assertOwnedQuiz(quizId, tutorId, false); const questions = await storage.getSomaQuestionsByQuizId(quiz.id); return { ...quiz, questions }; }
export async function managementDetails(quizId: number, tutorId: string) {
  const quiz = await assertOwnedQuiz(quizId, tutorId);
  const assignments = await storage.getQuizAssignmentsForQuiz(quizId);
  const allReports = await storage.getSomaReportsByQuizId(quizId);
  const questions = await storage.getSomaQuestionsByQuizId(quizId);
  const maxGrade = questions.reduce((sum, q) => sum + q.marks, 0);
  const { computeAssignmentStatus, ASSIGNMENT_STATUS_META } = await import("@shared/assignmentStatus");
  const now = new Date();
  const studentDetails = assignments.map((assignment) => {
    const report = (allReports as any[]).find((r) => r.studentId === assignment.student.id);
    const detailedStatus = computeAssignmentStatus({ dueDate: assignment.dueDate ?? null, report: report ? { status: report.status, answersJson: report.answersJson, aiFeedbackHtml: report.aiFeedbackHtml, structuredMarking: report.structuredMarking, completedAt: report.completedAt } : null, now });
    return { assignmentId: assignment.id, studentId: assignment.student.id, studentName: assignment.student.displayName || assignment.student.email, studentEmail: assignment.student.email, assignmentStatus: assignment.status, status: report ? (report.status === "completed" ? "Submitted" : report.status === "failed" ? "Failed" : "In Progress") : "Not Started", detailedStatus, detailedStatusLabel: ASSIGNMENT_STATUS_META[detailedStatus].label, startTime: report?.startedAt || report?.createdAt || null, submissionTime: report?.completedAt || null, finalGrade: report?.score ?? null, maxGrade, reportId: report?.id || null, dueDate: assignment.dueDate || null };
  });
  return { quiz, assignments: studentDetails, totalAssigned: studentDetails.length, totalSubmitted: studentDetails.filter((s) => s.detailedStatus === "submitted" || s.detailedStatus === "feedback_ready").length };
}
export async function reviewQuestions(quizId: number, tutorId: string) { await assertOwnedQuiz(quizId, tutorId); return (await storage.getSomaQuestionsByQuizId(quizId)).slice().sort((a,b)=>a.id-b.id).map((q)=>({ id: q.id, stem: q.stem, options: q.options, correctAnswer: q.correctAnswer, explanation: q.explanation, marks: q.marks, reviewStatus: q.reviewStatus, difficultyTag: q.difficultyTag, topicTag: q.topicTag, subtopicTag: q.subtopicTag, generationMeta: q.generationMeta })); }
export async function updateReview(quizId: number, questionId: number, tutorId: string, body: z.infer<typeof reviewPatchSchema>) {
  await assertOwnedQuiz(quizId, tutorId);
  const questions = await storage.getSomaQuestionsByQuizId(quizId);
  const existing = questions.find((q) => q.id === questionId);
  if (!existing) throw new TutorQuizError(404, "Question not found");
  if (body.action === "approve" || body.action === "restore") return storage.updateSomaQuestionReview(questionId, { reviewStatus: "approved" });
  if (body.action === "reject") return storage.updateSomaQuestionReview(questionId, { reviewStatus: "auto_blocked" });
  if (body.action === "exclude") { const correct = effectiveCorrectAnswer(existing.stem, existing.options as string[], existing.correctAnswer); const reports = await storage.getSomaReportsByQuizId(quizId); const affectedSubmissionCount = reports.filter((r) => r.status === "completed" && answersMatch(((r.answersJson ?? {}) as Record<string,string>)[String(questionId)], correct)).length; const updated = await storage.updateSomaQuestionReview(questionId, { reviewStatus: "excluded" }); return { ...updated, affectedSubmissionCount }; }
  const editPatch: { stem?: string; options?: string[]; correctAnswer?: string; explanation?: string } = {};
  if (body.stem !== undefined) editPatch.stem = body.stem; if (body.options !== undefined) editPatch.options = body.options; if (body.correctAnswer !== undefined) editPatch.correctAnswer = body.correctAnswer; if (body.explanation !== undefined) editPatch.explanation = body.explanation;
  const merged = { stem: editPatch.stem ?? existing.stem, options: (editPatch.options ?? (existing.options as string[])) as string[], correct_answer: editPatch.correctAnswer ?? existing.correctAnswer, explanation: editPatch.explanation ?? existing.explanation, difficulty_tag: existing.difficultyTag ?? undefined };
  const quality = validateQuestionQuality(merged);
  return storage.updateSomaQuestionReview(questionId, { ...editPatch, reviewStatus: quality.reviewStatus });
}
export async function updateMetadata(quizId: number, tutorId: string, body: any) {
  const existing = await storage.getSomaQuiz(quizId); if (!existing) throw new TutorQuizError(404, "Quiz not found"); if (existing.authorId !== tutorId) throw new TutorQuizError(403, "Access denied");
  const { title, syllabus, level, subject, topics, timeLimitMinutes, format, quizMode, questionCount, structuredCount } = body; const updates: Record<string, string | number | string[] | null> = {};
  if (title !== undefined) updates.title = title; if (syllabus !== undefined) updates.syllabus = syllabus || null; if (level !== undefined) updates.level = level || null; if (subject !== undefined) updates.subject = subject || null;
  const currentFormat = (existing as any).format === "pdf" ? "pdf" : "mcq"; if (format !== undefined) { const requested = format === "pdf" ? "pdf" : "mcq"; if (requested !== currentFormat) throw new TutorQuizError(409, "Assessment type cannot be changed after creation."); }
  const currentMode = (existing as any).quizMode ?? "mcq"; if (quizMode !== undefined && currentFormat !== "pdf") { const requestedMode = ["mcq", "structured", "hybrid"].includes(quizMode) ? quizMode : "mcq"; if (requestedMode !== currentMode) throw new TutorQuizError(409, "Question style cannot be changed after creation."); }
  if (currentFormat !== "pdf" && (questionCount !== undefined || structuredCount !== undefined)) { const norm = normalizeQuizModeFields(currentFormat, currentMode, questionCount ?? (existing as any).questionCount, structuredCount ?? (existing as any).structuredCount); updates.questionCount = norm.count; updates.structuredCount = norm.structured; }
  if (topics !== undefined) { const clean = Array.isArray(topics) ? topics.map((t: unknown) => String(t || "").trim()).filter(Boolean) : []; updates.topics = clean; updates.topic = clean[0] || (title ?? existing.title); }
  if (timeLimitMinutes !== undefined) updates.timeLimitMinutes = Number(timeLimitMinutes) || 60;
  return storage.updateSomaQuiz(quizId, updates);
}
export async function archive(quizId: number, tutorId: string) { const quiz = await storage.getSomaQuiz(quizId); if (!quiz) throw new TutorQuizError(404, "Quiz not found"); if (quiz.authorId !== tutorId) throw new TutorQuizError(403, "Access denied"); const updated = await storage.updateSomaQuiz(quizId, { isArchived: !quiz.isArchived }); return { success: true, isArchived: updated?.isArchived }; }
export async function remove(quizId: number, tutorId: string) { const quiz = await storage.getSomaQuiz(quizId); if (!quiz) throw new TutorQuizError(404, "Quiz not found"); if (quiz.authorId !== tutorId) throw new TutorQuizError(403, "You can only delete your own quizzes"); const paths = await collectQuizStoragePaths(quizId); await storage.deleteSomaQuiz(quizId); await purgeStorageObjects(paths); return { success: true }; }
