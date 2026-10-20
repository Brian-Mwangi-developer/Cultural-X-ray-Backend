import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { config } from "@/config/env";
import { errorDetails, logger } from "@/observability/logger";
import { httpErrorsTotal } from "@/observability/metrics";

/**
 * An expected failure. For 4xx the message is shown to people as written, so write it
 * for them; `code` is a stable identifier the web app can branch on.
 */
export class HttpError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(
    readonly status: number,
    message: string,
    options: { code?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.code = options.code ?? defaultCode(status);
    this.details = options.details;
  }
}

function defaultCode(status: number) {
  return { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 410: "GONE" }[status] ?? "ERROR";
}

export const routeLabel = (req: Request) => (req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched");

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, "Not found"));
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const route = routeLabel(req);
  if (error instanceof ZodError) {
    httpErrorsTotal.inc({ route, status_code: "400", kind: "validation" });
    res.status(400).json({ error: { code: "INVALID_INPUT", message: error.issues[0]?.message ?? "Check the details and try again", issues: error.issues } });
    return;
  }
  if (error instanceof HttpError) {
    httpErrorsTotal.inc({ route, status_code: String(error.status), kind: "expected" });
    res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }

  const reference = `ERR-${randomBytes(4).toString("hex").toUpperCase()}`;
  httpErrorsTotal.inc({ route, status_code: "500", kind: "unexpected" });
  logger.error({ reference, route, method: req.method, requestId: req.headers["x-request-id"], ...errorDetails(error) }, "unhandled request error");
  res.status(500).json({
    error: {
      code: "SERVER_ERROR",
      message: "Something went wrong on our side",
      reference,
      ...(!config.isProduction && error instanceof Error ? { debug: error.message } : {}),
    },
  });
}
