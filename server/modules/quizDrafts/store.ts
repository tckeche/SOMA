import type { DraftQuestion } from "@shared/schema";
const draftStore = new Map<number, { questions: DraftQuestion[]; updatedAt: Date }>();
export function getDraft(quizId: number): DraftQuestion[] { return draftStore.get(quizId)?.questions ?? []; }
export function setDraft(quizId: number, questions: DraftQuestion[]): Date { const updatedAt = new Date(); draftStore.set(quizId, { questions, updatedAt }); return updatedAt; }
export function clearDraft(quizId: number): void { draftStore.delete(quizId); }
