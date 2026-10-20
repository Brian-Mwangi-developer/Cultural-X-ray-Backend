import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { sampleEmail, SAMPLE_TEMPLATES } from "@/modules/email/email.samples";
import { config } from "@/config/env";
import { requireToken } from "@/http/middleware";
import { peekDeadLetters, queueDepths, replayDeadLetters } from "@/messaging/dead-letters";
import { publish } from "@/messaging/publisher";
import { EXCHANGES } from "@/messaging/topology";
import { SYSTEM_ECHO } from "@/modules/ops/diagnostics.queue";
import { enqueueEmail } from "@/modules/email/email.queue";
import { describeSesAccount } from "@/modules/email/email.transport";

export const opsRouter = Router();
opsRouter.use(requireToken(config.security.opsToken));

opsRouter.get("/queues", async (_req, res, next) => {
  try {
    res.json({ queues: await queueDepths() });
  } catch (error) {
    next(error);
  }
});

opsRouter.get("/dead-letters", async (req, res, next) => {
  try {
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit);
    res.json({ deadLetters: await peekDeadLetters(limit) });
  } catch (error) {
    next(error);
  }
});

opsRouter.post("/dead-letters/replay", async (req, res, next) => {
  try {
    const body = z.object({ limit: z.number().int().min(1).max(1_000).default(50), sourceQueue: z.string().optional() }).parse(req.body ?? {});
    res.json(await replayDeadLetters({ limit: body.limit, ...(body.sourceQueue && { sourceQueue: body.sourceQueue }) }));
  } catch (error) {
    next(error);
  }
});

// End-to-end pipeline check: publish an echo job; the worker writes a receipt to Redis.
opsRouter.post("/diagnostics/echo", async (_req, res, next) => {
  try {
    const token = randomUUID();
    const result = await publish(EXCHANGES.system.name, SYSTEM_ECHO, { token });
    res.status(202).json({ token, ...result });
  } catch (error) {
    next(error);
  }
});

opsRouter.get("/email/ses", async (_req, res, next) => {
  try {
    res.json(await describeSesAccount());
  } catch (error) {
    next(error);
  }
});

opsRouter.post("/email/test", async (req, res, next) => {
  try {
    const { to, template } = z
      .object({ to: z.email(), template: z.enum(SAMPLE_TEMPLATES).optional() })
      .parse(req.body ?? {});
    const job = template
      ? sampleEmail(template, to)
      : ({
          template: "plain",
          to,
          subject: "Cultural X-Ray email test",
          text: "This is a test email from the Cultural X-Ray backend. If you can read it, SES delivery works.",
        } as const);
    const result = await enqueueEmail(job);
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});
