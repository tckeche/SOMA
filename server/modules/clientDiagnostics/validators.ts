import { z } from "zod";
export const clientErrorReportSchema = z.object({
  timestamp: z.string().max(64), route: z.string().max(2048), boundaryTitle: z.string().max(256),
  error: z.object({ name: z.string().max(256), message: z.string().max(2000), stack: z.string().max(4000).optional(), componentStack: z.string().max(4000).optional() }),
  user: z.object({ id: z.string().max(128).optional(), role: z.string().max(64).optional() }).optional(), requestId: z.string().max(128),
});
