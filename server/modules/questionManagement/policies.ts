import { storage } from "../../storage";

export async function getQuizForQuestionWrite(quizId: number, tutorId: string) {
  const quiz = await storage.getSomaQuiz(quizId);
  if (!quiz) return { ok: false as const, status: 404, message: "Quiz not found" };
  if (quiz.authorId !== tutorId) return { ok: false as const, status: 403, message: "Access denied" };
  return { ok: true as const, quiz };
}
