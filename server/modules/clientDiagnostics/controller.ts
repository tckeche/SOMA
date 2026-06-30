import type { Request, Response } from "express";
import { logClientError } from "./service";
import { clientErrorReportSchema } from "./validators";
export async function report(req: Request, res: Response) {
  const parsed = clientErrorReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid client error report" });
  return res.status(202).json(logClientError(parsed.data, (req as any).authUser));
}
