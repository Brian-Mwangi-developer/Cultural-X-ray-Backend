import type { ConfirmChannel, Options } from "amqplib";
import { logger } from "@/observability/logger";
import type { ExchangeSpec, QueueSpec } from "@/messaging/types";

export const DEAD_LETTER_EXCHANGE = "xray.dlx";
export const DEAD_LETTER_QUEUE = "xray.dead_letters";

export const EXCHANGES = {
  email: { name: "xray.email", type: "topic" },
  jobs: { name: "xray.jobs", type: "topic" },
  system: { name: "xray.system", type: "topic" },
} as const satisfies Record<string, ExchangeSpec>;

export const QUEUES = {
  email: {
    name: "xray.email.send",
    exchange: EXCHANGES.email.name,
    bindings: ["email.#"],
    prefetch: 10,
    maxAttempts: 5,
    retryDelayMs: 15_000,
    maxPriority: 10,
    maxLength: 100_000,
  },
  mapBuild: {
    name: "xray.map.build",
    exchange: EXCHANGES.jobs.name,
    bindings: ["map.build", "plays.write"],
    prefetch: 2,
    maxAttempts: 3,
    retryDelayMs: 30_000,
    maxPriority: 10,
  },
  adCheck: {
    name: "xray.ad.check",
    exchange: EXCHANGES.jobs.name,
    bindings: ["ad.check", "ad.recut"],
    prefetch: 1,
    maxAttempts: 3,
    retryDelayMs: 60_000,
    maxPriority: 10,
  },
  siteRead: {
    name: "xray.site.read",
    exchange: EXCHANGES.jobs.name,
    bindings: ["site.read"],
    prefetch: 4,
    maxAttempts: 2,
    retryDelayMs: 2_000,
    maxPriority: 10,
  },
  diagnostics: {
    name: "xray.system.diagnostics",
    exchange: EXCHANGES.system.name,
    bindings: ["system.#"],
    prefetch: 5,
    maxAttempts: 2,
    retryDelayMs: 500,
  },
} as const satisfies Record<string, QueueSpec>;

export const ALL_QUEUES: QueueSpec[] = Object.values(QUEUES);

export const retryQueueName = (queue: string) => `${queue}.retry`;

function mainQueueArgs(queue: QueueSpec): Options.AssertQueue["arguments"] {
  return {
    "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
    "x-dead-letter-routing-key": queue.name,
    ...(queue.maxPriority && { "x-max-priority": queue.maxPriority }),
    ...(queue.maxLength && { "x-max-length": queue.maxLength, "x-overflow": "reject-publish-dlx" }),
  };
}

// A retry queue has no consumers. Messages sit for retryDelayMs, then the broker
// dead-letters them back to the source queue through the default exchange.
function retryQueueArgs(queue: QueueSpec): Options.AssertQueue["arguments"] {
  return {
    "x-message-ttl": queue.retryDelayMs,
    "x-dead-letter-exchange": "",
    "x-dead-letter-routing-key": queue.name,
  };
}

const isPreconditionFailed = (error: unknown) => /PRECONDITION_FAILED|406/.test(String(error instanceof Error ? error.message : error));

/**
 * Declares a queue. If its arguments changed since it was first declared, the broker
 * refuses (406). We redeclare only when the queue is empty, never dropping work.
 */
async function assertQueueSafely(
  channel: ConfirmChannel,
  reopen: () => Promise<ConfirmChannel>,
  name: string,
  args: Options.AssertQueue["arguments"],
): Promise<ConfirmChannel> {
  try {
    await channel.assertQueue(name, { durable: true, arguments: args });
    return channel;
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    const fresh = await reopen();
    const { messageCount } = await fresh.checkQueue(name);
    if (messageCount > 0) {
      throw new Error(`Queue ${name} changed shape but still holds ${messageCount} message(s); drain it before redeploying`, {
        cause: error,
      });
    }
    logger.warn({ queue: name }, "redeclaring empty queue whose arguments changed");
    await fresh.deleteQueue(name);
    await fresh.assertQueue(name, { durable: true, arguments: args });
    return fresh;
  }
}

export async function assertTopology(channel: ConfirmChannel, reopen: () => Promise<ConfirmChannel>): Promise<ConfirmChannel> {
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });
  channel = await assertQueueSafely(channel, reopen, DEAD_LETTER_QUEUE, {});

  for (const exchange of Object.values(EXCHANGES)) {
    await channel.assertExchange(exchange.name, exchange.type, { durable: true });
  }

  for (const queue of ALL_QUEUES) {
    channel = await assertQueueSafely(channel, reopen, queue.name, mainQueueArgs(queue));
    channel = await assertQueueSafely(channel, reopen, retryQueueName(queue.name), retryQueueArgs(queue));
    for (const pattern of queue.bindings) await channel.bindQueue(queue.name, queue.exchange, pattern);
    await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, queue.name);
  }

  logger.info(
    { exchanges: Object.values(EXCHANGES).map((e) => e.name), queues: ALL_QUEUES.map((q) => q.name) },
    "messaging topology asserted",
  );
  return channel;
}
