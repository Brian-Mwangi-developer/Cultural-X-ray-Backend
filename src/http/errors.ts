import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { config } from "@/config/env";
import { errorDetails, logger } from "@/observability/logger";
import { httpErrorsTotal } from "@/observability/metrics";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const routeLabel = (req: Request) => (req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched");

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, "Not found"));
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  const route = routeLabel(req);
  if (error instanceof ZodError) {
    httpErrorsTotal.inc({ route, status_code: "400", kind: "validation" });
    res.status(400).json({ error: { message: "Invalid request", issues: error.issues } });
    return;
  }
  if (error instanceof HttpError) {
    httpErrorsTotal.inc({ route, status_code: String(error.status), kind: "expected" });
    res.status(error.status).json({ error: { message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }

  const reference = `ERR-${randomBytes(4).toString("hex").toUpperCase()}`;
  httpErrorsTotal.inc({ route, status_code: "500", kind: "unexpected" });
  logger.error({ reference, route, method: req.method, requestId: req.headers["x-request-id"], ...errorDetails(error) }, "unhandled request error");
  res.status(500).json({
    error: {
      message: "Something went wrong on our side",
      reference,
      ...(!config.isProduction && error instanceof Error ? { debug: error.message } : {}),
    },
  });
}
