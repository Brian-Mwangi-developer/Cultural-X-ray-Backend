import { z } from "zod";
import { redis } from "@/infra/redis";
import { type Handler, type HandlerMap, Outcome, PermanentError } from "@/messaging/types";

export const SYSTEM_ECHO = "system.echo";
export const SYSTEM_FAIL = "system.fail";
export const SYSTEM_REJECT = "system.reject";

const echoSchema = z.object({ token: z.string().min(1) });

export const echoKey = (token: string) => `diag:echo:${token}`;

// Round-trips through RabbitMQ and leaves a receipt in Redis: proves publish → consume → side effect.
const echo: Handler<typeof echoSchema> = {
  schema: echoSchema,
  async handle({ token }, envelope) {
    await redis.set(echoKey(token), JSON.stringify({ id: envelope.id, attempt: envelope.attempt, at: new Date().toISOString() }), "EX", 300);
    return Outcome.Processed;
  },
};

// Always throws a transient error: exercises the delayed-retry path, then dead-lettering.
const fail: Handler<typeof echoSchema> = {
  schema: echoSchema,
  async handle({ token }, envelope) {
    await redis.rpush(`diag:fail:${token}`, String(envelope.attempt));
    await redis.expire(`diag:fail:${token}`, 300);
    throw new Error(`Diagnostic failure on attempt ${envelope.attempt}`);
  },
};

// Throws a permanent error: must skip retries and dead-letter immediately.
const reject: Handler<typeof echoSchema> = {
  schema: echoSchema,
  async handle() {
    throw new PermanentError("Diagnostic permanent failure");
  },
};

export const diagnosticHandlers: HandlerMap = {
  [SYSTEM_ECHO]: echo as Handler,
  [SYSTEM_FAIL]: fail as Handler,
  [SYSTEM_REJECT]: reject as Handler,
};
