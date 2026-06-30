import { z } from "zod";
export const levelsQuerySchema = z.object({ body: z.string().min(1, "body is required") });
export const subjectsQuerySchema = z.object({ body: z.string().min(1, "body is required"), level: z.string().min(1, "level is required") });
export const topicsQuerySchema = z.object({ body: z.string().min(1, "body is required"), level: z.string().min(1, "level is required"), subject: z.string().min(1, "subject is required") });
export const topicContextQuerySchema = z.object({ topicIds: z.string().min(1, "topicIds is required").transform((raw, ctx) => {
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((s) => Number(s));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "topicIds must be comma-separated positive integers" }); return z.NEVER; }
  return ids;
}) });
export function firstZodMessage(error: any) { return error.errors[0]?.message || "Invalid query"; }
