import type { DraftQuestion } from "@shared/schema";
import { storage } from "../../storage";
import { listAllowedTopicsForSyllabusCode } from "../../services/catalogueInventory";
import { countWithField, traceLog } from "../../services/quizTraceLog";
import { clearDraft, getDraft, setDraft } from "../quizDrafts/store";
import { MAX_QUESTIONS_PER_QUIZ, mapDraftToInsertQuestions, QuestionValidationError, summarizeReviewStatuses, validateDraftForPublish } from "../questionValidation/service";
import { requireOwnedQuiz } from "./policies";

export class QuizPublishError extends Error { constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); } }
function parseBoardAndSyllabusCode(raw: string): { board: string; syllabusCode: string } { const [boardRaw, codeRaw] = String(raw || "").split(":"); return { board: (boardRaw || "").trim(), syllabusCode: (codeRaw || boardRaw || "").trim() }; }
function domainFromValidation(err: QuestionValidationError): QuizPublishError { return new QuizPublishError(err.status, err.message, err.details); }
export async function publish(quizId: number, tutorId: string, body: { questions?: unknown[] }, traceId: string) {
  const owned = await requireOwnedQuiz(quizId, tutorId);
  if (!owned.ok) throw new QuizPublishError(owned.status, owned.message);
  const quiz = owned.quiz;
  traceLog("route.publish.entry", { route: "/api/tutor/quizzes/:quizId/publish", quizId, quizSyllabus: quiz.syllabus, clientBodyHasQuestions: Array.isArray(body?.questions), clientBodyQuestionCount: Array.isArray(body?.questions) ? body.questions.length : 0 }, traceId);
  let draft = getDraft(quizId);
  if (draft.length === 0 && Array.isArray(body?.questions) && body.questions.length > 0) {
    console.log(`[PUBLISH] Server draftStore empty for quiz ${quizId} — using ${body.questions.length} client-sent questions as fallback`);
    draft = body.questions as DraftQuestion[];
    setDraft(quizId, draft);
  }
  if (quiz.format === "pdf") { await storage.updateSomaQuiz(quizId, { status: "published" }); clearDraft(quizId); return { quizId, publishedCount: 0, questions: [], format: "pdf" }; }
  if (draft.length === 0) throw new QuizPublishError(400, "Draft is empty — add questions before publishing");
  if (draft.length > MAX_QUESTIONS_PER_QUIZ) throw new QuizPublishError(400, `A quiz can have at most ${MAX_QUESTIONS_PER_QUIZ} questions (draft has ${draft.length}). Remove some before publishing.`);
  traceLog("route.publish.draftLoaded", { quizId, draftSource: getDraft(quizId).length > 0 && draft === getDraft(quizId) ? "serverStore" : "clientBody", draftCount: draft.length, draftRowsWithSeeds: countWithField(draft as unknown as Record<string, unknown>[], "targetMisconceptionIds"), sampleDraft: draft.slice(0, 1).map((q) => ({ stem: q.stem.slice(0, 50), targetMisconceptionIds: (q as any).targetMisconceptionIds ?? null, subtopicId: (q as any).subtopicId ?? null, learningRequirementId: (q as any).learningRequirementId ?? null })) }, traceId);
  const { syllabusCode } = parseBoardAndSyllabusCode(quiz.syllabus ?? "");
  const allowedTopics = await listAllowedTopicsForSyllabusCode(syllabusCode);
  let reviewStatusByIndex;
  try { reviewStatusByIndex = validateDraftForPublish(draft, allowedTopics).reviewStatusByIndex; } catch (err) { if (err instanceof QuestionValidationError) throw domainFromValidation(err); throw err; }
  const mapped = mapDraftToInsertQuestions(quizId, draft, reviewStatusByIndex);
  traceLog("route.publish.beforePublishTransactional", { quizId, mappedCount: mapped.length, rowsWithTargetMisconceptionIds: countWithField(mapped as unknown as Record<string, unknown>[], "targetMisconceptionIds"), rowsWithSubtopicId: countWithField(mapped as unknown as Record<string, unknown>[], "subtopicId") }, traceId);
  const saved = await storage.publishSomaQuestionsTransactional(quizId, mapped as any);
  traceLog("route.publish.afterPublishTransactional", { quizId, savedCount: saved.length, savedRowsWithSeeds: countWithField(saved as unknown as Record<string, unknown>[], "targetMisconceptionIds") }, traceId);
  clearDraft(quizId);
  return { quizId, publishedCount: saved.length, questions: saved, reviewSummary: summarizeReviewStatuses(saved) };
}
