import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { mqOutboxDepth } from "@/observability/metrics";

const PENDING = (exchange: string) => `mq:outbox:${exchange}`;
const INFLIGHT = (exchange: string) => `mq:outbox:${exchange}:inflight`;

export interface OutboxEntry {
  exchange: string;
  routingKey: string;
  body: string;
  priority?: number;
  enqueuedAt: string;
  attempts: number;
}

export async function park(entry: OutboxEntry): Promise<void> {
  await redis.rpush(PENDING(entry.exchange), JSON.stringify(entry));
}

/** Atomically moves the oldest entry to in-flight so a crash mid-delivery cannot lose it. */
export async function take(exchange: string): Promise<{ entry: OutboxEntry; raw: string } | null> {
  const raw = await redis.lmove(PENDING(exchange), INFLIGHT(exchange), "LEFT", "RIGHT");
  if (!raw) return null;
  try {
    return { entry: JSON.parse(raw) as OutboxEntry, raw };
  } catch {
    await redis.lrem(INFLIGHT(exchange), 1, raw);
    logger.error({ exchange }, "outbox: discarded unparseable entry");
    return null;
  }
}

export async function delivered(exchange: string, raw: string): Promise<void> {
  await redis.lrem(INFLIGHT(exchange), 1, raw);
}

export async function giveBack(exchange: string, raw: string, entry: OutboxEntry): Promise<void> {
  await redis
    .multi()
    .lrem(INFLIGHT(exchange), 1, raw)
    .rpush(PENDING(exchange), JSON.stringify({ ...entry, attempts: entry.attempts + 1 }))
    .exec();
}

/** On startup, anything left in-flight by a previous process goes back to pending. */
export async function recover(exchange: string): Promise<number> {
  let moved = 0;
  while (await redis.lmove(INFLIGHT(exchange), PENDING(exchange), "LEFT", "RIGHT")) moved++;
  if (moved) logger.warn({ exchange, moved }, "outbox: recovered in-flight entries");
  return moved;
}

export async function depth(exchange: string): Promise<number> {
  const [pending, inflight] = await Promise.all([redis.llen(PENDING(exchange)), redis.llen(INFLIGHT(exchange))]);
  return pending + inflight;
}

export async function reportDepth(exchange: string): Promise<void> {
  try {
    mqOutboxDepth.set({ exchange }, await depth(exchange));
  } catch (error) {
    logger.debug(errorDetails(error), "outbox depth unavailable");
  }
}
