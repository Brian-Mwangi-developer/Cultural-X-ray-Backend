import type { z } from "zod";

export interface Envelope<T = unknown> {
  id: string;
  type: string;
  payload: T;
  createdAt: string;
  attempt: number;
  correlationId?: string;
  organizationId?: string;
}

export enum Outcome {
  Processed = "processed",
  Skipped = "skipped",
}

/** Thrown when retrying cannot help (bad data, unknown recipient). Goes straight to dead letters. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface Handler<S extends z.ZodType = z.ZodType> {
  schema: S;
  handle: (payload: z.infer<S>, envelope: Envelope<z.infer<S>>) => Promise<Outcome>;
}

export type HandlerMap = Record<string, Handler>;

export interface ExchangeSpec {
  name: string;
  type: "topic" | "direct" | "fanout";
}

export interface QueueSpec {
  name: string;
  exchange: string;
  bindings: string[];
  prefetch: number;
  maxAttempts: number;
  retryDelayMs: number;
  maxPriority?: number;
  maxLength?: number;
}

export interface PublishResult {
  ok: boolean;
  id: string;
  durable?: "broker" | "outbox";
}

export const HEADERS = {
  attempt: "x-xray-attempt",
  sourceQueue: "x-xray-source-queue",
  errorMessage: "x-xray-error-message",
  errorName: "x-xray-error-name",
  failedAt: "x-xray-failed-at",
  reason: "x-xray-reason",
  messageType: "x-xray-message-type",
} as const;
