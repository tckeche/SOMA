import { z } from "zod";
export function parseQuizId(value: unknown): number { return parseInt(String(value), 10); }
export const saveDraftSchema = z.object({ questions: z.array(z.any()) });
