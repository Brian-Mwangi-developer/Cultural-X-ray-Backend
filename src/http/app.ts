import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { toNodeHandler } from "better-auth/node";
import { config } from "@/config/env";
import { errorHandler, notFound } from "@/http/errors";
import { httpMetrics, requestId, requireToken } from "@/http/middleware";
import { createApiRateLimit } from "@/http/rate-limit";
import { registry } from "@/observability/metrics";
import { auth } from "@/modules/auth/auth";
import { healthRouter } from "@/modules/health/health.routes";
import { meRouter } from "@/modules/me/me.routes";
import { opsRouter } from "@/modules/ops/ops.routes";
import { orgsRouter } from "@/modules/orgs/orgs.routes";
import { connectionsRouter } from "@/modules/connections/connections.routes";
import { lookupRouter } from "@/modules/lookup/lookup.routes";
import { mapsRouter } from "@/modules/maps/maps.routes";
import { askRouter } from "@/modules/ask/ask.routes";
import { adCheckRouter } from "@/modules/adcheck/adcheck.routes";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(httpMetrics);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cors({ origin: config.http.webOrigins, credentials: true }));

  app.use(healthRouter);
  app.get("/metrics", requireToken(config.security.metricsToken), async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  });

  // Better Auth reads the raw body itself, so it is mounted before the JSON parser.
  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json({ limit: "1mb" }));
  app.use("/api/v1", createApiRateLimit(), meRouter, orgsRouter, connectionsRouter, lookupRouter, mapsRouter, askRouter, adCheckRouter);
  app.use("/api/v1/ops", opsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
