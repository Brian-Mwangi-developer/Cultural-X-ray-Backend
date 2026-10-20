import { rabbitmq } from "@/infra/rabbitmq";
import { logger } from "@/observability/logger";
import { mqQueueDepth } from "@/observability/metrics";
import { ALL_QUEUES, DEAD_LETTER_QUEUE, retryQueueName } from "@/messaging/topology";
import { HEADERS } from "@/messaging/types";

export interface DeadLetterView {
  id: string | undefined;
  type: string | undefined;
  sourceQueue: string | undefined;
  reason: string | undefined;
  error: string | undefined;
  attempt: number | undefined;
  failedAt: string | undefined;
  body: unknown;
}

const header = (headers: Record<string, unknown> | undefined, key: string) => headers?.[key] as string | undefined;

/** Reads up to `limit` dead letters without removing them (they are nacked back in order). */
export async function peekDeadLetters(limit = 20): Promise<DeadLetterView[]> {
  const channel = await rabbitmq.openChannel();
  const seen: DeadLetterView[] = [];
  const held = [];
  try {
    for (let i = 0; i < limit; i++) {
      const message = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
      if (!message) break;
      held.push(message);
      const headers = message.properties.headers as Record<string, unknown> | undefined;
      let body: unknown = message.content.toString();
      try {
        body = JSON.parse(String(body));
      } catch {
        // keep raw text
      }
      seen.push({
        id: message.properties.messageId,
        type: header(headers, HEADERS.messageType),
        sourceQueue: header(headers, HEADERS.sourceQueue),
        reason: header(headers, HEADERS.reason),
        error: header(headers, HEADERS.errorMessage),
        attempt: Number(headers?.[HEADERS.attempt] ?? 0),
        failedAt: header(headers, HEADERS.failedAt),
        body,
      });
    }
  } finally {
    for (const message of held.reverse()) channel.nack(message, false, true);
    await channel.close();
  }
  return seen;
}

/** Moves dead letters back to their source queue with a fresh attempt counter. */
export async function replayDeadLetters(options: { limit: number; sourceQueue?: string }): Promise<{ replayed: number; skipped: number }> {
  const channel = await rabbitmq.openChannel();
  let replayed = 0;
  let skipped = 0;
  const keep = [];
  try {
    for (let i = 0; i < options.limit; i++) {
      const message = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
      if (!message) break;
      const headers = message.properties.headers as Record<string, unknown> | undefined;
      const source = header(headers, HEADERS.sourceQueue);
      if (!source || (options.sourceQueue && source !== options.sourceQueue)) {
        keep.push(message);
        skipped++;
        continue;
      }
      let body = message.content;
      try {
        const envelope = JSON.parse(body.toString()) as { attempt?: number };
        envelope.attempt = 1;
        body = Buffer.from(JSON.stringify(envelope));
      } catch {
        // replay as-is; the consumer will dead-letter it again as malformed
      }
      channel.sendToQueue(source, body, {
        persistent: true,
        contentType: "application/json",
        messageId: message.properties.messageId,
        type: message.properties.type,
        headers: { [HEADERS.attempt]: 1 },
      });
      await channel.waitForConfirms();
      channel.ack(message);
      replayed++;
    }
  } finally {
    for (const message of keep.reverse()) channel.nack(message, false, true);
    await channel.close();
  }
  logger.warn({ replayed, skipped, sourceQueue: options.sourceQueue }, "dead letters replayed");
  return { replayed, skipped };
}

export async function queueDepths(): Promise<Record<string, { ready: number; consumers: number }>> {
  const channel = await rabbitmq.openChannel();
  const result: Record<string, { ready: number; consumers: number }> = {};
  try {
    const names = [DEAD_LETTER_QUEUE, ...ALL_QUEUES.flatMap((q) => [q.name, retryQueueName(q.name)])];
    for (const name of names) {
      const { messageCount, consumerCount } = await channel.checkQueue(name);
      result[name] = { ready: messageCount, consumers: consumerCount };
      mqQueueDepth.set({ queue: name }, messageCount);
    }
  } finally {
    await channel.close();
  }
  return result;
}

let sampler: NodeJS.Timeout | null = null;

export function startDepthSampler(intervalMs = 15_000): void {
  if (sampler) return;
  const tick = () => queueDepths().catch((error) => logger.debug({ error: String(error) }, "queue depth sample failed"));
  void tick();
  sampler = setInterval(tick, intervalMs);
  sampler.unref();
}

export function stopDepthSampler(): void {
  if (sampler) clearInterval(sampler);
  sampler = null;
}
