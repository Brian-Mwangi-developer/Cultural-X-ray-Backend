import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "@/http/app";
import { rabbitmq } from "@/infra/rabbitmq";
import { DEAD_LETTER_QUEUE } from "@/messaging/topology";
import { HEADERS } from "@/messaging/types";

export async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

export interface FoundDeadLetter {
  reason: string;
  sourceQueue: string;
  attempt: number;
  type: string | undefined;
  body: string;
}

/** Removes (acks) dead letters whose body contains `marker`; leaves everything else in place. */
export async function takeDeadLetters(marker: string): Promise<FoundDeadLetter[]> {
  const channel = await rabbitmq.openChannel();
  const found: FoundDeadLetter[] = [];
  const others = [];
  try {
    for (;;) {
      const message = await channel.get(DEAD_LETTER_QUEUE, { noAck: false });
      if (!message) break;
      const body = message.content.toString();
      if (body.includes(marker)) {
        const headers = (message.properties.headers ?? {}) as Record<string, unknown>;
        found.push({
          reason: String(headers[HEADERS.reason]),
          sourceQueue: String(headers[HEADERS.sourceQueue]),
          attempt: Number(headers[HEADERS.attempt] ?? 0),
          type: headers[HEADERS.messageType] as string | undefined,
          body,
        });
        channel.ack(message);
      } else {
        others.push(message);
      }
    }
  } finally {
    for (const message of others.reverse()) channel.nack(message, false, true);
    await channel.close();
  }
  return found;
}
