export function parseQuizId(raw: unknown, message = "Invalid quiz ID"): number {
  const quizId = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(quizId) || quizId <= 0) throw new Error(message);
  return quizId;
}
