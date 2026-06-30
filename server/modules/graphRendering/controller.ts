import type { Request, Response } from "express";
import { graphQuestionSpecSchema } from "@shared/schema";
import { renderGraph } from "./service";
export async function renderSvg(req: Request, res: Response) {
  const parsed = graphQuestionSpecSchema.safeParse(req.body?.spec);
  if (!parsed.success) return res.status(400).json({ message: "Invalid graph spec", details: parsed.error.flatten() });
  const svg = await renderGraph(parsed.data);
  if (!svg) return res.status(503).json({ message: "Python graph rendering unavailable" });
  return res.json({ svg });
}
