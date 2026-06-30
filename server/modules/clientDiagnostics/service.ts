import type { z } from "zod";
import type { clientErrorReportSchema } from "./validators";
export function logClientError(report: z.infer<typeof clientErrorReportSchema>, authUser?: { id?: string; role?: string }) {
  console.warn("[client-error]", { timestamp: report.timestamp, route: report.route, boundaryTitle: report.boundaryTitle, errorName: report.error.name, errorMessage: report.error.message, requestId: report.requestId, userId: authUser?.id || report.user?.id, role: authUser?.role || report.user?.role, stack: report.error.stack, componentStack: report.error.componentStack });
  return { ok: true, requestId: report.requestId };
}
