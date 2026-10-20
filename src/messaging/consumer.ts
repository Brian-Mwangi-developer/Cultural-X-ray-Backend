import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { rabbitmq } from "@/infra/rabbitmq";
import { errorDetails, logger } from "@/observability/logger";
import { mqConsumeTotal, mqDeadLetterTotal, mqHandlerDuration, mqRetryTotal } from "@/observability/metrics";
import { DEAD_LETTER_EXCHANGE, retryQueueName } from "@/messaging/topology";
import { type Envelope, HEADERS, type HandlerMap, Outcome, PermanentError, type QueueSpec } from "@/messaging/types";

type DeadLetterReason = "malformed_json" | "invalid_payload" | "no_handler" | "permanent_error" | "max_attempts";

async function deadLetter(
  channel: ConfirmChannel,
  queue: QueueSpec,
  raw: ConsumeMessage,
  body: Buffer,
  reason: DeadLetterReason,
  error: unknown,
  envelope?: Envelope,
): Promise<void> {
  const { error: message, errorName } = { errorName: "Error", ...errorDetails(error) } as { error: string; errorName: string };
  try {
    channel.publish(DEAD_LETTER_EXCHANGE, queue.name, body, {
      persistent: true,
      contentType: raw.properties.contentType ?? "application/json",
      messageId: raw.properties.messageId ?? envelope?.id,
      type: raw.properties.type,
      timestamp: raw.properties.timestamp ?? Date.now(),
      headers: {
        ...raw.properties.headers,
        [HEADERS.sourceQueue]: queue.name,
        [HEADERS.reason]: reason,
        [HEADERS.errorMessage]: message.slice(0, 1_000),
        [HEADERS.errorName]: errorName,
        [HEADERS.failedAt]: new Date().toISOString(),
        [HEADERS.attempt]: envelope?.attempt ?? 0,
        ...(envelope?.type && { [HEADERS.messageType]: envelope.type }),
      },
    });
    await channel.waitForConfirms();
    channel.ack(raw);
    mqDeadLetterTotal.inc({ queue: queue.name, reason });
    logger.error({ queue: queue.name, id: envelope?.id, type: envelope?.type, reason, error: message }, "message dead-lettered");
  } catch (publishError) {
    // Never let the dead-letter path itself lose the message: keep the original delivery.
    logger.error({ queue: queue.name, ...errorDetails(publishError) }, "dead-letter publish unconfirmed, requeueing original");
    try {
      channel.nack(raw, false, true);
    } catch {
      // A closed channel requeues unacked deliveries itself.
    }
  }
}

async function scheduleRetry(channel: ConfirmChannel, queue: QueueSpec, raw: ConsumeMessage, envelope: Envelope, error: unknown): Promise<void> {
  const next: Envelope = { ...envelope, attempt: envelope.attempt + 1 };
  try {
    channel.sendToQueue(retryQueueName(queue.name), Buffer.from(JSON.stringify(next)), {
      persistent: true,
      contentType: "application/json",
      messageId: envelope.id,
      type: envelope.type,
      priority: raw.properties.priority,
      timestamp: raw.properties.timestamp ?? Date.now(),
      headers: {
        ...raw.properties.headers,
        [HEADERS.attempt]: next.attempt,
        [HEADERS.errorMessage]: errorDetails(error).error.slice(0, 1_000),
      },
    });
    await channel.waitForConfirms();
    channel.ack(raw);
    mqRetryTotal.inc({ queue: queue.name });
    logger.warn({ queue: queue.name, id: envelope.id, type: envelope.type, nextAttempt: next.attempt, delayMs: queue.retryDelayMs, ...errorDetails(error) }, "handler failed, retry scheduled");
  } catch (retryError) {
    logger.error({ queue: queue.name, ...errorDetails(retryError) }, "retry publish unconfirmed, requeueing original");
    try {
      channel.nack(raw, false, true);
    } catch {
      // see above
    }
  }
}

async function handle(channel: ConfirmChannel, queue: QueueSpec, handlers: HandlerMap, raw: ConsumeMessage): Promise<void> {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw.content.toString()) as Envelope;
    if (!envelope || typeof envelope.type !== "string" || typeof envelope.id !== "string") throw new Error("Not an envelope");
    envelope.attempt = Number(envelope.attempt) || 1;
  } catch (error) {
    mqConsumeTotal.inc({ queue: queue.name, result: "malformed" });
    await deadLetter(channel, queue, raw, raw.content, "malformed_json", error);
    return;
  }

  const handler = handlers[envelope.type];
  if (!handler) {
    mqConsumeTotal.inc({ queue: queue.name, result: "no_handler" });
    await deadLetter(channel, queue, raw, raw.content, "no_handler", new Error(`No handler for ${envelope.type}`), envelope);
    return;
  }

  const parsed = handler.schema.safeParse(envelope.payload);
  if (!parsed.success) {
    mqConsumeTotal.inc({ queue: queue.name, result: "invalid" });
    await deadLetter(channel, queue, raw, raw.content, "invalid_payload", new Error(parsed.error.message), envelope);
    return;
  }

  const stop = mqHandlerDuration.startTimer({ queue: queue.name, type: envelope.type });
  try {
    const outcome = await handler.handle(parsed.data, { ...envelope, payload: parsed.data });
    if (!Object.values(Outcome).includes(outcome)) throw new Error(`Handler for ${envelope.type} returned no outcome`);
    channel.ack(raw);
    mqConsumeTotal.inc({ queue: queue.name, result: outcome });
  } catch (error) {
    if (error instanceof PermanentError) {
      mqConsumeTotal.inc({ queue: queue.name, result: "failed" });
      await deadLetter(channel, queue, raw, raw.content, "permanent_error", error, envelope);
    } else if (envelope.attempt >= queue.maxAttempts) {
      mqConsumeTotal.inc({ queue: queue.name, result: "failed" });
      await deadLetter(channel, queue, raw, raw.content, "max_attempts", error, envelope);
    } else {
      mqConsumeTotal.inc({ queue: queue.name, result: "retry" });
      await scheduleRetry(channel, queue, raw, envelope, error);
    }
  } finally {
    stop();
  }
}

const running = new Map<string, { channel: ConfirmChannel; tag: string }>();

/** Starts a consumer on its own channel so one queue's prefetch never starves another. */
export async function startConsumer(queue: QueueSpec, handlers: HandlerMap): Promise<void> {
  const channel = await rabbitmq.openChannel();
  await channel.prefetch(queue.prefetch);
  const { consumerTag } = await channel.consume(queue.name, (raw) => {
    if (raw) void handle(channel, queue, handlers, raw);
  });
  running.set(queue.name, { channel, tag: consumerTag });
  logger.info({ queue: queue.name, prefetch: queue.prefetch, types: Object.keys(handlers) }, "consumer started");
}

export async function stopConsumers(): Promise<void> {
  for (const [queue, { channel, tag }] of running) {
    try {
      await channel.cancel(tag);
      await channel.close();
    } catch (error) {
      logger.warn({ queue, ...errorDetails(error) }, "consumer stop error");
    }
  }
  running.clear();
}
