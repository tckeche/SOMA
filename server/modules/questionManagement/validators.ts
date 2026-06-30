export function parseQuizId(raw: unknown): number {
  const quizId = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(quizId) || quizId <= 0) throw new Error("Invalid quiz ID");
  return quizId;
}
