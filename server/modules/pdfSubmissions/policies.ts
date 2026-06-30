import { storage } from "../../storage";

export async function requireTutorOwnsQuiz(quizId: number, tutorId: string) {
  const quiz = await storage.getSomaQuiz(quizId);
  if (!quiz || quiz.authorId !== tutorId) return undefined;
  return quiz;
}
