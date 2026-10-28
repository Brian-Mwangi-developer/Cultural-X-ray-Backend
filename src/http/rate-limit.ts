import { createHash } from "node:crypto";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { redis } from "@/infra/redis";
import { httpErrorsTotal } from "@/observability/metrics";

// Built after Redis connects: the store loads its Lua script on construction.
export function createApiRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Per signed-in session, not per address: the web's server renders every page from one address,
    // so keyed by IP all its visitors would share one budget and a busy minute would fail pages.
    keyGenerator: (req) => {
      const token = req.headers.cookie?.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/)?.[1];
      return token ? `s:${createHash("sha256").update(token).digest("hex").slice(0, 32)}` : ipKeyGenerator(req.ip ?? "unknown");
    },
    // Fail open: a Redis outage should slow nothing down, not lock everyone out.
    skip: () => redis.status !== "ready",
    passOnStoreError: true,
    store: new RedisStore({
      prefix: "rl:api:",
      sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
    }),
    handler: (_req, res) => {
      httpErrorsTotal.inc({ route: "/api/v1", status_code: "429", kind: "rate_limit" });
      res.status(429).json({ error: { message: "Too many requests, slow down a little" } });
    },
  });
}
