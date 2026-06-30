import crypto from "node:crypto";
import { z } from "zod";
import type { AuthMetadata } from "./types";

export const authMetadataSchema = z.object({
  display_name: z.string().optional(),
  full_name: z.string().optional(),
  requested_role: z.string().optional(),
  subject: z.string().optional(),
  syllabus: z.string().optional(),
  syllabus_code: z.string().optional(),
  level: z.string().optional(),
  subjects: z.array(z.object({ subject: z.string(), examBody: z.string(), syllabusCode: z.string(), level: z.string() })).optional(),
}).passthrough();

export function parseAuthMetadata(value: unknown): AuthMetadata | undefined {
  const parsed = authMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashEmailForLog(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const normalised = canonicalEmail(email);
  if (!normalised) return undefined;
  return crypto.createHash("sha256").update(normalised).digest("hex");
}
