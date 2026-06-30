export function parseQuizId(raw: unknown): number {
  const quizId = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(quizId) || quizId <= 0) throw new Error("Invalid quiz ID");
  return quizId;
}

export function parseQuestionId(raw: unknown): number {
  const questionId = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(questionId) || questionId <= 0) throw new Error("Invalid question ID");
  return questionId;
}
