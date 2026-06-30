import type { SomaQuestion } from "@shared/schema";
import { storage } from "../../storage";
import { isServableToStudent } from "../../services/questionQuality";
import type { SomaReadAuthUser, StudentSafeQuestion } from "./types";

export class StudentQuizTakingError extends Error { constructor(public status: number, message: string) { super(message); } }

export function sanitizeQuestionForPreSubmission(q: SomaQuestion): StudentSafeQuestion {
  return {
    id: q.id,
    quizId: q.quizId,
    stem: q.stem,
    options: q.options,
    marks: q.marks,
    questionType: q.questionType,
    graphSpec: q.graphSpec,
  };
}

export async function listQuizzes(authUser: SomaReadAuthUser) {
  const authUserId = String(authUser.id);
  if (authUser.role === "super_admin" || authUser.role === "tutor") {
    const allQuizzes = (await storage.getSomaQuizzes()).filter((q) => !q.isArchived);
    return authUser.role === "super_admin" ? allQuizzes : allQuizzes.filter((q) => q.authorId === authUserId);
  }

  const assignments = await storage.getQuizAssignmentsForStudent(authUserId);
  const seen = new Set<number>();
  const assigned = [];
  for (const assignment of assignments) {
    if (!assignment.quiz || assignment.quiz.isArchived || seen.has(assignment.quiz.id)) continue;
    seen.add(assignment.quiz.id);
    assigned.push(assignment.quiz);
  }
  return assigned;
}

export async function getQuiz(quizId: number) {
  const quiz = await storage.getSomaQuiz(quizId);
  if (!quiz || quiz.isArchived) throw new StudentQuizTakingError(404, "Quiz not found");
  return quiz;
}

export async function getQuestions(quizId: number): Promise<StudentSafeQuestion[]> {
  const allQuestions = (await storage.getSomaQuestionsByQuizId(quizId)).filter(isServableToStudent);
  return allQuestions.map(sanitizeQuestionForPreSubmission);
}

export async function checkSubmission(quizId: number, studentId: string) {
  const submitted = await storage.checkSomaSubmission(quizId, studentId);
  return { submitted };
}
