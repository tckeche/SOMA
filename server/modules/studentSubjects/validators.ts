import { z } from "zod";
export const studentSubjectPayloadSchema = z.object({ subject: z.string().min(1), examBody: z.string().min(1), syllabusCode: z.string().min(1), level: z.string().min(1) });
export function parseSubjectId(raw: string) { const subjectId = Number(raw); return Number.isFinite(subjectId) ? subjectId : null; }
