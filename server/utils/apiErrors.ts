import type { Request, Response } from "express";

export type ApiErrorDetails = Record<string, unknown> | unknown[] | string | number | boolean | null;

function getErrorDetails(err: unknown) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(typeof (err as any).code !== "undefined" ? { code: (err as any).code } : {}),
      ...(typeof (err as any).status !== "undefined" ? { status: (err as any).status } : {}),
      ...(typeof (err as any).statusCode !== "undefined" ? { statusCode: (err as any).statusCode } : {}),
      ...(typeof (err as any).details !== "undefined" ? { details: (err as any).details } : {}),
    };
  }

  return { value: err };
}

export function logInternalError(req: Request, err: unknown, context: string) {
  console.error(JSON.stringify({
    level: "error",
    event: "api_internal_error",
    context,
    method: req.method,
    path: req.originalUrl || req.url,
    params: req.params,
    query: req.query,
    error: getErrorDetails(err),
  }));
}

export function sendApiError(
  res: Response,
  status: number,
  publicMessage: string,
  code = `HTTP_${status}`,
  details: ApiErrorDetails = null,
) {
  return res.status(status).json({
    error: {
      code,
      message: publicMessage,
      details,
    },
  });
}

export function sendInternalError(
  req: Request,
  res: Response,
  err: unknown,
  context: string,
  publicMessage = "Something went wrong. Please try again.",
) {
  logInternalError(req, err, context);
  return sendApiError(
    res,
    500,
    publicMessage,
    "INTERNAL_SERVER_ERROR",
  );
}
