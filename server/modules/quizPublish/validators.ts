import { z } from "zod";
export function parseQuizId(value: unknown): number { return parseInt(String(value), 10); }
export const publishBodySchema = z.object({ questions: z.array(z.any()).optional() }).passthrough();
