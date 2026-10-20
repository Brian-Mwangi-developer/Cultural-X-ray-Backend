import type { SecondaryStorage } from "better-auth";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";

const PREFIX = "auth:";

// INCR and set the window TTL only when the counter is created, in one atomic step.
const INCREMENT_WITH_TTL = `local v = redis.call('INCR', KEYS[1]) if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return v`;

// Better Auth uses this for session lookups and its rate limiter. A Redis outage
// degrades to "cache miss" (reads fall back to Postgres) instead of failing sign-ins.
export const redisSecondaryStorage: SecondaryStorage = {
  async get(key) {
    try {
      return await redis.get(PREFIX + key);
    } catch (error) {
      logger.warn({ ...errorDetails(error) }, "auth cache read failed");
      return null;
    }
  },
  async getAndDelete(key) {
    try {
      return await redis.getdel(PREFIX + key);
    } catch (error) {
      logger.warn({ ...errorDetails(error) }, "auth cache getdel failed");
      return null;
    }
  },
  async increment(key, ttl) {
    try {
      return Number(await redis.eval(INCREMENT_WITH_TTL, 1, PREFIX + key, String(ttl)));
    } catch (error) {
      // Fail open: a Redis outage must not lock users out of signing in.
      logger.warn({ ...errorDetails(error) }, "auth rate-limit counter failed");
      return 1;
    }
  },
  async set(key, value, ttl) {
    try {
      if (ttl) await redis.set(PREFIX + key, value, "EX", ttl);
      else await redis.set(PREFIX + key, value);
    } catch (error) {
      logger.warn({ ...errorDetails(error) }, "auth cache write failed");
    }
  },
  async delete(key) {
    try {
      await redis.del(PREFIX + key);
    } catch (error) {
      logger.warn({ ...errorDetails(error) }, "auth cache delete failed");
    }
  },
};
