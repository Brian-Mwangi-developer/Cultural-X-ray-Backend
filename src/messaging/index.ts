import { rabbitmq } from "@/infra/rabbitmq";
import { logger } from "@/observability/logger";
import { startConsumer, stopConsumers } from "@/messaging/consumer";
import { startDepthSampler, stopDepthSampler } from "@/messaging/dead-letters";
import { startOutboxDrain, stopOutboxDrain } from "@/messaging/publisher";
import { assertTopology, QUEUES } from "@/messaging/topology";
import type { HandlerMap, QueueSpec } from "@/messaging/types";
import { emailHandlers } from "@/modules/email/email.queue";
import { diagnosticHandlers } from "@/modules/ops/diagnostics.queue";
import { siteHandlers } from "@/modules/lookup/site";
import { mapHandlers } from "@/modules/maps/map.build";
import { playHandlers } from "@/modules/plays/plays.queue";
import { adCheckHandlers } from "@/modules/adcheck/adcheck.queue";
import { startVideoSweep, stopVideoSweep } from "@/modules/adcheck/adcheck.service";

/**
 * Queue → handlers. A queue that is declared but not listed here
 * keeps its messages until a handler ships; nothing is consumed and silently dropped.
 */
const CONSUMERS: Array<[QueueSpec, HandlerMap]> = [
  [QUEUES.email, emailHandlers],
  [QUEUES.diagnostics, diagnosticHandlers],
  [QUEUES.siteRead, siteHandlers],
  [QUEUES.mapBuild, { ...mapHandlers, ...playHandlers }],
  [QUEUES.adCheck, adCheckHandlers],
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
  startVideoSweep();
  logger.info({ consumers: CONSUMERS.map(([q]) => q.name) }, "workers listening");
}

export async function stopMessaging(): Promise<void> {
  stopDepthSampler();
  stopOutboxDrain();
  stopVideoSweep();
  await stopConsumers();
  await rabbitmq.close();
}
