import { randomUUID } from "node:crypto";
import type { ConfirmChannel } from "amqplib";
import { rabbitmq } from "@/infra/rabbitmq";
import { errorDetails, logger } from "@/observability/logger";
import { mqConfirmDuration, mqPublishTotal } from "@/observability/metrics";
import * as outbox from "@/messaging/outbox";
import { EXCHANGES } from "@/messaging/topology";
import { type Envelope, HEADERS, type PublishResult } from "@/messaging/types";

const CONFIRM_TIMEOUT_MS = 3_000;
const DRAIN_INTERVAL_MS = 5_000;
const DRAIN_BATCH = 200;

export interface PublishOptions {
  priority?: number;
  correlationId?: string;
  organizationId?: string;
}

const withTimeout = (promise: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => (clearTimeout(timer), resolve(true)),
      () => (clearTimeout(timer), resolve(false)),
    );
  });

async function sendConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, body: Buffer, envelope: Pick<Envelope, "id" | "type" | "attempt">, priority?: number) {
  const accepted = channel.publish(exchange, routingKey, body, {
    persistent: true,
    contentType: "application/json",
    messageId: envelope.id,
    type: envelope.type,
    timestamp: Date.now(),
    priority,
    headers: { [HEADERS.attempt]: envelope.attempt, [HEADERS.messageType]: envelope.type },
  });
  if (!accepted) await new Promise((resolve) => channel.once("drain", resolve));
  const stop = mqConfirmDuration.startTimer({ exchange });
  const confirmed = await withTimeout(channel.waitForConfirms(), CONFIRM_TIMEOUT_MS);
  stop();
  return confirmed;
}

/**
 * Publish an event. Returns only when it is durable: confirmed by RabbitMQ, or parked
 * in the Redis outbox (replayed by the drain loop). `ok: false` means neither worked.
 */
export async function publish<T>(exchange: string, type: string, payload: T, options: PublishOptions = {}): Promise<PublishResult> {
  const envelope: Envelope<T> = {
    id: randomUUID(),
    type,
    payload,
    createdAt: new Date().toISOString(),
    attempt: 1,
    ...(options.correlationId && { correlationId: options.correlationId }),
    ...(options.organizationId && { organizationId: options.organizationId }),
  };
  const body = Buffer.from(JSON.stringify(envelope));

  const channel = rabbitmq.tryChannel();
  if (channel) {
    try {
      if (await sendConfirmed(channel, exchange, type, body, envelope, options.priority)) {
        mqPublishTotal.inc({ exchange, result: "broker" });
        return { ok: true, id: envelope.id, durable: "broker" };
      }
      logger.warn({ exchange, type, id: envelope.id }, "publish not confirmed in time, parking in outbox");
    } catch (error) {
      logger.warn({ exchange, type, id: envelope.id, ...errorDetails(error) }, "publish failed, parking in outbox");
    }
  }

  try {
    await outbox.park({
      exchange,
      routingKey: type,
      body: body.toString(),
      ...(options.priority !== undefined && { priority: options.priority }),
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    });
    mqPublishTotal.inc({ exchange, result: "outbox" });
    void outbox.reportDepth(exchange);
    return { ok: true, id: envelope.id, durable: "outbox" };
  } catch (error) {
    mqPublishTotal.inc({ exchange, result: "failed" });
    logger.error({ exchange, type, id: envelope.id, ...errorDetails(error) }, "publish failed: broker and outbox both unavailable");
    return { ok: false, id: envelope.id };
  }
}

let drainTimer: NodeJS.Timeout | null = null;
let draining = false;

async function drainOnce(): Promise<void> {
  if (draining) return;
  const channel = rabbitmq.tryChannel();
  if (!channel) return;
  draining = true;
  try {
    for (const { name: exchange } of Object.values(EXCHANGES)) {
      for (let i = 0; i < DRAIN_BATCH; i++) {
        const next = await outbox.take(exchange);
        if (!next) break;
        const envelope = JSON.parse(next.entry.body) as Envelope;
        const ok = await sendConfirmed(channel, exchange, next.entry.routingKey, Buffer.from(next.entry.body), envelope, next.entry.priority).catch(() => false);
        if (!ok) {
          await outbox.giveBack(exchange, next.raw, next.entry);
          break;
        }
        await outbox.delivered(exchange, next.raw);
      }
      await outbox.reportDepth(exchange);
    }
  } catch (error) {
    logger.error(errorDetails(error), "outbox drain pass failed");
  } finally {
    draining = false;
  }
}

export async function startOutboxDrain(): Promise<void> {
  if (drainTimer) return;
  for (const { name } of Object.values(EXCHANGES)) await outbox.recover(name).catch(() => 0);
  drainTimer = setInterval(() => void drainOnce(), DRAIN_INTERVAL_MS);
  drainTimer.unref();
  logger.info({ intervalMs: DRAIN_INTERVAL_MS }, "outbox drain started");
}

export function stopOutboxDrain(): void {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}

export { drainOnce as drainOutboxNow };
