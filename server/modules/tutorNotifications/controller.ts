import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import * as service from "./service";
export async function list(req: Request, res: Response) { try { return res.json(await service.list((req as any).tutorId)); } catch (err: any) { return sendInternalError(req, res, err, "routes.failed_to_fetch_notifications", "Failed to fetch notifications"); } }
export async function markRead(req: Request, res: Response) { try { const row = await service.markRead(Number(req.params.id), (req as any).tutorId); if (!row) return res.status(404).json({ message: "Notification not found" }); return res.json(row); } catch (err: any) { return sendInternalError(req, res, err, "routes.failed_to_update_notification", "Failed to update notification"); } }
