import { rabbitmq } from "@/infra/rabbitmq";
import { logger } from "@/observability/logger";
import { startConsumer, stopConsumers } from "@/messaging/consumer";
import { startDepthSampler, stopDepthSampler } from "@/messaging/dead-letters";
import { startOutboxDrain, stopOutboxDrain } from "@/messaging/publisher";
import { assertTopology, QUEUES } from "@/messaging/topology";
import type { HandlerMap, QueueSpec } from "@/messaging/types";
import { emailHandlers } from "@/modules/email/email.queue";
import { diagnosticHandlers } from "@/modules/ops/diagnostics.queue";

/**
 * Queue → handlers. A queue that is declared but not listed here (map build, ad check)
 * keeps its messages until a handler ships; nothing is consumed and silently dropped.
 */
const CONSUMERS: Array<[QueueSpec, HandlerMap]> = [
  [QUEUES.email, emailHandlers],
  [QUEUES.diagnostics, diagnosticHandlers],
];

async function declare(): Promise<void> {
  await assertTopology(rabbitmq.channel(), () => rabbitmq.replacePublishChannel());
}

/** API process: topology + publishing + outbox replay. No consumers. */
export async function startPublisherSide(): Promise<void> {
  await rabbitmq.connect();
  await declare();
  rabbitmq.whenReconnected(declare);
  await startOutboxDrain();
  logger.info("messaging ready for publishing");
}

/** Worker process: everything the API has, plus consumers and the depth sampler. */
export async function startWorkerSide(): Promise<void> {
  await startPublisherSide();
  const startAll = async () => {
    for (const [queue, handlers] of CONSUMERS) await startConsumer(queue, handlers);
  };
  await startAll();
  rabbitmq.whenReconnected(startAll);
  startDepthSampler();
  logger.info({ consumers: CONSUMERS.map(([q]) => q.name) }, "workers listening");
}

export async function stopMessaging(): Promise<void> {
  stopDepthSampler();
  stopOutboxDrain();
  await stopConsumers();
  await rabbitmq.close();
}
