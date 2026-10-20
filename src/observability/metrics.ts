import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";

export const registry = new Registry();
registry.setDefaultLabels({ service: "xray-backend" });
collectDefaultMetrics({ register: registry });

const register = [registry];

export const httpRequestDuration = new Histogram({
  name: "xray_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: register,
});

export const httpRequestsTotal = new Counter({
  name: "xray_http_requests_total",
  help: "HTTP requests by route and status",
  labelNames: ["method", "route", "status_code"] as const,
  registers: register,
});

export const httpErrorsTotal = new Counter({
  name: "xray_http_errors_total",
  help: "HTTP error responses by kind",
  labelNames: ["route", "status_code", "kind"] as const,
  registers: register,
});

export const dependencyUp = new Gauge({
  name: "xray_dependency_up",
  help: "1 when a dependency is reachable from this process, 0 otherwise",
  labelNames: ["dependency"] as const,
  registers: register,
});

export const mqPublishTotal = new Counter({
  name: "xray_mq_publish_total",
  help: "Publishes by outcome: broker (confirmed), outbox (parked in Redis), failed (neither)",
  labelNames: ["exchange", "result"] as const,
  registers: register,
});

export const mqConfirmDuration = new Histogram({
  name: "xray_mq_confirm_duration_seconds",
  help: "Time spent waiting for a RabbitMQ publisher confirm",
  labelNames: ["exchange"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: register,
});

export const mqConsumeTotal = new Counter({
  name: "xray_mq_consume_total",
  help: "Consumed messages by outcome",
  labelNames: ["queue", "result"] as const,
  registers: register,
});

export const mqHandlerDuration = new Histogram({
  name: "xray_mq_handler_duration_seconds",
  help: "Time a consumer handler spent on one message",
  labelNames: ["queue", "type"] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120],
  registers: register,
});

export const mqRetryTotal = new Counter({
  name: "xray_mq_retry_total",
  help: "Confirmed retry republishes",
  labelNames: ["queue"] as const,
  registers: register,
});

export const mqDeadLetterTotal = new Counter({
  name: "xray_mq_dead_letter_total",
  help: "Messages moved to the dead-letter queue",
  labelNames: ["queue", "reason"] as const,
  registers: register,
});

export const mqQueueDepth = new Gauge({
  name: "xray_mq_queue_depth",
  help: "Ready messages per queue, sampled by the worker",
  labelNames: ["queue"] as const,
  registers: register,
});

export const mqOutboxDepth = new Gauge({
  name: "xray_mq_outbox_depth",
  help: "Envelopes parked in the Redis outbox. Sustained > 0 means RabbitMQ is not accepting publishes",
  labelNames: ["exchange"] as const,
  registers: register,
});

export const emailSentTotal = new Counter({
  name: "xray_email_sent_total",
  help: "Emails handed to the transport, by template and outcome",
  labelNames: ["template", "transport", "result"] as const,
  registers: register,
});
