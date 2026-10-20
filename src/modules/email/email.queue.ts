import { logger } from "@/observability/logger";
import { emailSentTotal } from "@/observability/metrics";
import { publish } from "@/messaging/publisher";
import { EXCHANGES } from "@/messaging/topology";
import { type Handler, type HandlerMap, Outcome } from "@/messaging/types";
import { type EmailJob, emailJobSchema, render } from "@/modules/email/email.templates";
import { emailTransport } from "@/modules/email/email.transport";

export const EMAIL_SEND = "email.send";

/** Producer side: the API never talks to SES directly; it enqueues and returns. */
export async function enqueueEmail(job: EmailJob, options: { priority?: number } = {}) {
  const result = await publish(EXCHANGES.email.name, EMAIL_SEND, emailJobSchema.parse(job), { priority: options.priority ?? 5 });
  if (!result.ok) logger.error({ template: job.template, id: result.id }, "email could not be queued");
  return result;
}

// RFC 2606 / 6761 reserved names can never receive mail. Sending to them only bounces and
// hurts the sender's SES reputation, so they are skipped (tests sign up with these).
const RESERVED_DOMAIN = /(?:\.(?:test|example|invalid|localhost)|@example\.(?:com|net|org))$/i;
export const isUndeliverable = (address: string) => RESERVED_DOMAIN.test(address.trim());

const sendEmail: Handler<typeof emailJobSchema> = {
  schema: emailJobSchema,
  async handle(job, envelope) {
    if (isUndeliverable(job.to)) {
      emailSentTotal.inc({ template: job.template, transport: emailTransport.name, result: "skipped" });
      logger.info({ id: envelope.id, template: job.template }, "email skipped: reserved test domain");
      return Outcome.Skipped;
    }
    try {
      const { messageId } = await emailTransport.send(job.to, render(job));
      emailSentTotal.inc({ template: job.template, transport: emailTransport.name, result: "sent" });
      logger.info({ id: envelope.id, template: job.template, transport: emailTransport.name, messageId }, "email sent");
      return Outcome.Processed;
    } catch (error) {
      emailSentTotal.inc({ template: job.template, transport: emailTransport.name, result: "failed" });
      throw error;
    }
  },
};

export const emailHandlers: HandlerMap = { [EMAIL_SEND]: sendEmail as Handler };
