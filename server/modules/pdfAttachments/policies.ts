import { storage } from "../../storage";

export async function requireTutorOwnsQuiz(quizId: number, tutorId: string) {
  const quiz = await storage.getSomaQuiz(quizId);
  if (!quiz || quiz.authorId !== tutorId) return undefined;
  return quiz;
}

export async function canAccessQuizAttachments(quizId: number, userId: string): Promise<boolean> {
  const quiz = await storage.getSomaQuiz(quizId);
  if (!quiz) return false;
  if (quiz.authorId === userId) return true;
  const assignment = await storage.getQuizAssignment(quizId, userId);
  return Boolean(assignment);
}
