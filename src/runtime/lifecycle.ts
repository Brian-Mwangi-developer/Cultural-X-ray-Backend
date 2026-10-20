import { disconnectDatabase, checkDatabase } from "@/infra/database";
import { connectRedis, disconnectRedis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { stopMessaging } from "@/messaging/index";

type Closer = { name: string; close: () => Promise<unknown> };

export async function connectCore(): Promise<void> {
  await connectRedis();
  if (!(await checkDatabase())) throw new Error("Postgres is not reachable");
  logger.info("core dependencies connected (postgres, redis)");
}

/** Closes in reverse order of dependency, once, with a hard deadline. */
export function handleShutdown(role: string, extra: Closer[] = []): void {
  let stopping = false;
  const closers: Closer[] = [
    ...extra,
    { name: "messaging", close: stopMessaging },
    { name: "redis", close: disconnectRedis },
    { name: "postgres", close: disconnectDatabase },
  ];

  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ role, signal }, "shutting down");
    const deadline = setTimeout(() => {
      logger.error({ role }, "shutdown deadline passed, forcing exit");
      process.exit(1);
    }, 15_000);
    deadline.unref();
    for (const { name, close } of closers) {
      try {
        await close();
      } catch (error) {
        logger.warn({ name, ...errorDetails(error) }, "close failed");
      }
    }
    logger.info({ role }, "shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ ...errorDetails(reason) }, "unhandled rejection"));
}
