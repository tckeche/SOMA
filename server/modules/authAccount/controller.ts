import type { Request, Response } from "express";
import { sendInternalError } from "../../utils/apiErrors";
import { getCurrentAccount, syncAccount, AuthHttpError } from "./service";
import { parseAuthMetadata } from "./validators";

function sendAuthError(res: Response, err: AuthHttpError) {
  return res.status(err.status).json({ message: err.message });
}

export async function sync(req: Request, res: Response) {
  try {
    const user = await syncAccount(req, parseAuthMetadata(req.body?.user_metadata));
    return res.json(user);
  } catch (err: any) {
    if (err instanceof AuthHttpError) return sendAuthError(res, err);
    return sendInternalError(req, res, err, "auth.sync", "We could not sync your account. Please try again.");
  }
}

export async function me(req: Request, res: Response) {
  try {
    const user = await getCurrentAccount(req);
    return res.json(user);
  } catch (err: any) {
    if (err instanceof AuthHttpError) return sendAuthError(res, err);
    return sendInternalError(req, res, err, "auth.me", "We could not load your account. Please try again.");
  }
}
