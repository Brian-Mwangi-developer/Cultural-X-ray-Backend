import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError, routeLabel } from "@/http/errors";
import { logger } from "@/observability/logger";
import { httpRequestDuration, httpRequestsTotal } from "@/observability/metrics";

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.headers["x-request-id"] = id;
  res.setHeader("X-Request-Id", id);
  next();
}

// Route labels come from the matched route only, never the raw path, so metrics
// cardinality cannot be inflated by arbitrary URLs.
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const stop = httpRequestDuration.startTimer();
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const labels = { method: req.method, route: routeLabel(req), status_code: String(res.statusCode) };
    stop(labels);
    httpRequestsTotal.inc(labels);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 3_000) logger.warn({ ...labels, ms: Math.round(ms) }, "slow request");
  });
  next();
}

export const tokenMatches = (provided: string, expected: string) => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Guards internal endpoints (metrics, ops) with a bearer token compared in constant time. */
export function requireToken(expected: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !tokenMatches(token, expected)) return next(new HttpError(401, "Missing or invalid token"));
    next();
  };
}
