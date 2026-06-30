import type { SomaQuestion } from "@shared/schema";

export type SomaReadAuthUser = { id: string | string[]; role?: string | null; email?: string | null };

export type StudentSafeQuestion = Pick<SomaQuestion, "id" | "quizId" | "stem" | "options" | "marks" | "questionType" | "graphSpec">;
