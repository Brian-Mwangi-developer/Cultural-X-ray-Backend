import { Redis } from "ioredis";
import { config } from "@/config/env";
import { errorDetails, logger } from "@/observability/logger";
import { dependencyUp } from "@/observability/metrics";

function createClient(name: string): Redis {
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    connectionName: `xray-${name}-${process.pid}`,
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    keepAlive: 30_000,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 3_000) + Math.floor(Math.random() * 250),
    reconnectOnError: (error) => error.message.includes("READONLY"),
  });

  client.on("ready", () => {
    dependencyUp.set({ dependency: "redis" }, 1);
    logger.info({ client: name }, "redis ready");
  });
  client.on("error", (error) => logger.warn({ client: name, ...errorDetails(error) }, "redis error"));
  client.on("close", () => dependencyUp.set({ dependency: "redis" }, 0));
  return client;
}

export const redis = createClient("main");

export async function connectRedis(timeoutMs = 15_000): Promise<void> {
  if (redis.status === "ready") return;
  if (redis.status === "wait" || redis.status === "end") {
    await redis.connect();
  } else {
    // Already connecting (something issued a command first): wait for the real ready event.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        redis.off("ready", onReady);
        reject(new Error("Redis did not become ready in time"));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      redis.once("ready", onReady);
    });
  }
  await redis.ping();
}

export async function checkRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
