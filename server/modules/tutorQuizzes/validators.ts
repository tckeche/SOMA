import { z } from "zod";
export function parseId(raw: unknown): number { return parseInt(String(raw), 10); }
export const reviewPatchSchema = z.object({
  action: z.enum(["approve", "reject", "exclude", "restore"]).optional(),
  stem: z.string().min(1).optional(),
  options: z.array(z.string()).length(4).optional(),
  correctAnswer: z.string().min(1).optional(),
  explanation: z.string().min(1).optional(),
}).refine((b) => b.action !== undefined || b.stem !== undefined || b.options !== undefined || b.correctAnswer !== undefined || b.explanation !== undefined, { message: "Provide an action or at least one field to edit" });
