import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

type SendApiErrorOptions = {
  status: number;
  code?: string;
  message: string;
  details?: unknown;
};

const STATUS_MESSAGES: Record<number, string> = {
  400: "Please check your request and try again.",
  401: "Please sign in to continue.",
  403: "You do not have permission to do that.",
  404: "We could not find what you requested.",
  409: "This request conflicts with existing information.",
  422: "Please check your request and try again.",
  429: "Too many requests. Please wait a moment and try again.",
  500: "Something went wrong. Please try again.",
  502: "A service we depend on is unavailable. Please try again.",
  503: "The service is temporarily unavailable. Please try again.",
};

function statusCodeName(status: number): string {
  return STATUS_MESSAGES[status] ? `HTTP_${status}` : "HTTP_ERROR";
}

function fallbackMessage(status: number): string {
  return STATUS_MESSAGES[status] ?? "Something went wrong. Please try again.";
}

function requestIdFor(req: Request): string {
  if (!req.requestId) req.requestId = randomUUID();
  return req.requestId;
}

function normalizeMessage(message: unknown, status: number): string {
  const value = typeof message === "string" ? message.trim() : "";
  return value || fallbackMessage(status);
}

export function createApiErrorEnvelope(req: Request, options: SendApiErrorOptions): ApiErrorEnvelope {
  const status = Number.isInteger(options.status) ? options.status : 500;
  const error: ApiErrorEnvelope["error"] = {
    code: options.code || statusCodeName(status),
    message: normalizeMessage(options.message, status),
    requestId: requestIdFor(req),
  };
  if (options.details !== undefined && options.details !== null) {
    error.details = options.details;
  }
  return { error };
}

export function sendApiError(req: Request, res: Response, options: SendApiErrorOptions): Response {
  return res.status(options.status).json(createApiErrorEnvelope(req, options));
}

function legacyBodyToOptions(status: number, body: any): SendApiErrorOptions | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (
    body.error
    && typeof body.error === "object"
    && body.error.code
    && body.error.message
    && body.error.requestId
  ) return null;

  if (body.error && typeof body.error === "object") {
    return {
      status,
      code: typeof body.error.code === "string" ? body.error.code : undefined,
      message: body.error.message ?? body.message ?? fallbackMessage(status),
      details: body.error.details ?? body.details ?? body.errors,
    };
  }

  if ("message" in body || "error" in body) {
    return {
      status,
      code: typeof body.code === "string" ? body.code : undefined,
      message: body.message ?? body.error ?? fallbackMessage(status),
      details: body.details ?? body.errors,
    };
  }

  return null;
}

export function attachRequestId(req: Request, res: Response, next: NextFunction) {
  req.requestId = (req.headers["x-request-id"] as string | undefined)?.trim() || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

export function installErrorResponseFormatter(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);
  res.json = ((body?: any) => {
    if (req.path.startsWith("/api") && res.statusCode >= 400) {
      const options = legacyBodyToOptions(res.statusCode, body);
      if (options) {
        return originalJson(createApiErrorEnvelope(req, options));
      }
    }
    return originalJson(body);
  }) as Response["json"];
  next();
}
