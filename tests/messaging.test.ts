import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRedis, disconnectRedis, redis } from "@/infra/redis";
import { rabbitmq } from "@/infra/rabbitmq";
import { startConsumer, stopConsumers } from "@/messaging/consumer";
import { replayDeadLetters } from "@/messaging/dead-letters";
import * as outbox from "@/messaging/outbox";
import { drainOutboxNow, publish } from "@/messaging/publisher";
import { assertTopology, EXCHANGES, QUEUES } from "@/messaging/topology";
import { diagnosticHandlers, echoKey, SYSTEM_ECHO, SYSTEM_FAIL, SYSTEM_REJECT } from "@/modules/ops/diagnostics.queue";
import { takeDeadLetters, waitFor } from "./helpers";

const SYSTEM = EXCHANGES.system.name;

beforeAll(async () => {
  await connectRedis();
  await rabbitmq.connect();
  await assertTopology(rabbitmq.channel(), () => rabbitmq.replacePublishChannel());
  // A running worker may also consume these; either one proves the same code path.
  await startConsumer(QUEUES.diagnostics, diagnosticHandlers);
});

afterAll(async () => {
  await stopConsumers();
  await rabbitmq.close();
  await disconnectRedis();
});

describe("publish → consume", () => {
  it("delivers a job and the handler's side effect lands", async () => {
    const token = randomUUID();
    const result = await publish(SYSTEM, SYSTEM_ECHO, { token });
    expect(result).toMatchObject({ ok: true, durable: "broker" });

    const receipt = await waitFor(async () => redis.get(echoKey(token)));
    expect(JSON.parse(receipt)).toMatchObject({ id: result.id, attempt: 1 });
  });
});

describe("retries and dead letters", () => {
  it("retries a transient failure after a delay, then dead-letters with max_attempts", async () => {
    const token = randomUUID();
    await publish(SYSTEM, SYSTEM_FAIL, { token });

    const [letter] = await waitFor(async () => {
      const found = await takeDeadLetters(token);
      return found.length ? found : null;
    }, 20_000);

    expect(letter).toMatchObject({ reason: "max_attempts", sourceQueue: QUEUES.diagnostics.name, type: SYSTEM_FAIL, attempt: 2 });
    const attempts = await redis.lrange(`diag:fail:${token}`, 0, -1);
    expect(attempts).toEqual(["1", "2"]);
  });

  it("dead-letters a permanent error immediately, without retrying", async () => {
    const token = randomUUID();
    await publish(SYSTEM, SYSTEM_REJECT, { token });
    const [letter] = await waitFor(async () => {
      const found = await takeDeadLetters(token);
      return found.length ? found : null;
    });
    expect(letter).toMatchObject({ reason: "permanent_error", attempt: 1 });
  });

  it("dead-letters invalid payloads, unknown types and malformed JSON", async () => {
    const marker = randomUUID();
    await publish(SYSTEM, SYSTEM_ECHO, { wrong: marker });
    await publish(SYSTEM, "system.unknown", { token: marker });
    const channel = rabbitmq.channel();
    channel.publish(SYSTEM, "system.raw", Buffer.from(`not json ${marker}`), { persistent: true });
    await channel.waitForConfirms();

    const letters = await waitFor(async () => {
      const found = await takeDeadLetters(marker);
      return found.length >= 3 ? found : null;
    });
    expect(letters.map((l) => l.reason).sort()).toEqual(["invalid_payload", "malformed_json", "no_handler"]);
  });

  it("replays a dead letter back to its source queue with a fresh attempt", async () => {
    const token = randomUUID();
    await publish(SYSTEM, SYSTEM_REJECT, { token });
    await waitFor(async () => (await rabbitmq.channel().checkQueue("xray.dead_letters")).messageCount > 0);
    const { replayed } = await replayDeadLetters({ limit: 100, sourceQueue: QUEUES.diagnostics.name });
    expect(replayed).toBeGreaterThan(0);
    const [again] = await waitFor(async () => {
      const found = await takeDeadLetters(token);
      return found.length ? found : null;
    });
    expect(again).toMatchObject({ reason: "permanent_error", attempt: 1 });
  });
});

describe("outbox fallback", () => {
  it("parks a publish in Redis when the broker is unavailable, then drains it", async () => {
    const token = randomUUID();
    await rabbitmq.close();

    const parked = await publish(SYSTEM, SYSTEM_ECHO, { token });
    expect(parked).toMatchObject({ ok: true, durable: "outbox" });
    expect(await outbox.depth(SYSTEM)).toBeGreaterThan(0);

    await rabbitmq.connect();
    await startConsumer(QUEUES.diagnostics, diagnosticHandlers);
    await drainOutboxNow();

    expect(await outbox.depth(SYSTEM)).toBe(0);
    await waitFor(async () => redis.get(echoKey(token)));
  });
});
