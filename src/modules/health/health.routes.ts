import { Router } from "express";
import { checkDatabase } from "@/infra/database";
import { rabbitmq } from "@/infra/rabbitmq";
import { checkRedis } from "@/infra/redis";

export const healthRouter = Router();

// Liveness: the process is up. Never touches dependencies, so orchestrators don't restart us during a blip.
healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: can we serve real traffic right now?
healthRouter.get("/ready", async (_req, res) => {
  const [postgres, redisOk] = await Promise.all([checkDatabase(), checkRedis()]);
  const checks = { postgres, redis: redisOk, rabbitmq: rabbitmq.isConnected() };
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "degraded", checks });
});
