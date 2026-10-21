import { createHash } from "node:crypto";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";

/**
 * Two-level cache for third-party lookups (Qloo, Firecrawl):
 *  1. Redis, for speed (search-as-you-type hits it on every keystroke).
 *  2. Postgres `qloo_cache`, so answers survive Redis restarts and are shared by every process.
 * Identical calls in flight at the same moment share one request (single flight).
 * Only successful answers are stored; empty answers count as successful ("not found" is an answer).
 */

const inflight = new Map<string, Promise<unknown>>();

export function cacheKey(path: string, params: Record<string, unknown>) {
  const sorted = Object.keys(params).sort().map((k) => [k, params[k]]);
  return "lk:v1:" + createHash("sha256").update(path + JSON.stringify(sorted)).digest("hex");
}

async function fromRedis<T>(key: string): Promise<T | undefined> {
  if (redis.status !== "ready") return undefined;
  try {
    const hit = await redis.get(key);
    return hit ? (JSON.parse(hit) as T) : undefined;
  } catch (error) {
    logger.warn({ key, ...errorDetails(error) }, "lookup cache: redis read failed");
    return undefined;
  }
}

async function toRedis(key: string, value: unknown, ttlSeconds: number) {
  if (redis.status !== "ready") return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (error) {
    logger.warn({ key, ...errorDetails(error) }, "lookup cache: redis write failed");
  }
}

export async function cached<T>(path: string, params: Record<string, unknown>, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const key = cacheKey(path, params);
  const hot = await fromRedis<T>(key);
  if (hot !== undefined) return hot;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const work = (async () => {
    const row = await prisma.qlooCache.findUnique({ where: { key } }).catch(() => null);
    if (row && (!row.expiresAt || row.expiresAt > new Date())) {
      const remaining = row.expiresAt ? Math.max(60, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)) : ttlSeconds;
      await toRedis(key, row.response, remaining);
      return row.response as T;
    }
    const value = await load();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await Promise.all([
      toRedis(key, value, ttlSeconds),
      prisma.qlooCache
        .upsert({
          where: { key },
          create: { key, path, params: params as object, response: value as object, httpStatus: 200, expiresAt },
          update: { response: value as object, httpStatus: 200, fetchedAt: new Date(), expiresAt },
        })
        .catch((error) => logger.warn({ key, path, ...errorDetails(error) }, "lookup cache: postgres write failed")),
    ]);
    return value;
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/** How long each kind of answer is kept. Taste data moves slowly; place details (hours) a little faster. */
export const TTL = {
  brandSearch: 7 * 86_400,
  placeSearch: 3 * 86_400,
  locality: 90 * 86_400,
  record: 14 * 86_400,
  insights: 7 * 86_400,
  tags: 30 * 86_400,
  site: 30 * 86_400,
} as const;
