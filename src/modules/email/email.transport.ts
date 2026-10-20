import { GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { fromEnv, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { config } from "@/config/env";
import { logger } from "@/observability/logger";
import { PermanentError } from "@/messaging/types";
import type { RenderedEmail } from "@/modules/email/email.templates";

export interface EmailTransport {
  name: "ses" | "log";
  send(to: string, email: RenderedEmail): Promise<{ messageId: string }>;
}

let sesClient: SESv2Client | null = null;
/**
 * Credentials set for this app (AWS_ACCESS_KEY_ID/SECRET in its env) always win over
 * ambient machine credentials such as a global AWS_PROFILE, which the SDK would otherwise
 * prefer. Without app keys (production IAM role, or a deliberate profile) the standard chain runs.
 */
export const sesCredentialSource = () =>
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? "app-env" : "default-chain";

export const getSesClient = () =>
  (sesClient ??= new SESv2Client({
    region: config.email.aws.region,
    credentials: sesCredentialSource() === "app-env" ? fromEnv() : fromNodeProviderChain(),
  }));

// SES rejects these for good: retrying only burns quota.
const PERMANENT_SES_ERRORS = new Set(["MessageRejected", "MailFromDomainNotVerifiedException", "AccountSuspendedException", "BadRequestException"]);

const sesTransport: EmailTransport = {
  name: "ses",
  async send(to, email) {
    try {
      const result = await getSesClient().send(
        new SendEmailCommand({
          FromEmailAddress: config.email.from,
          ...(config.email.replyTo && { ReplyToAddresses: [config.email.replyTo] }),
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: "UTF-8" },
              Body: { Html: { Data: email.html, Charset: "UTF-8" }, Text: { Data: email.text, Charset: "UTF-8" } },
            },
          },
        }),
      );
      return { messageId: result.MessageId ?? "unknown" };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (PERMANENT_SES_ERRORS.has(name)) throw new PermanentError(`SES ${name}: ${(error as Error).message}`);
      throw error;
    }
  },
};

const logTransport: EmailTransport = {
  name: "log",
  async send(to, email) {
    logger.info({ to, subject: email.subject, preview: email.text.slice(0, 300) }, "email (log transport, not sent)");
    return { messageId: `log-${Date.now()}` };
  },
};

export const emailTransport: EmailTransport = config.email.transport === "ses" ? sesTransport : logTransport;

/** Read-only check that the SES credentials work and whether the account can send to anyone yet. */
export async function describeSesAccount() {
  const client = getSesClient();
  const account = await client.send(new GetAccountCommand({}));
  const sender = config.email.from.match(/<([^>]+)>/)?.[1] ?? config.email.from;
  const domain = sender.split("@")[1] ?? "";
  const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain })).catch((error: Error) => ({ error: error.name }));
  const resolved = await client.config.credentials();
  return {
    region: config.email.aws.region,
    credentialSource: sesCredentialSource(),
    accessKeyIdEndsWith: resolved.accessKeyId.slice(-4),
    senderDomain: domain,
    senderVerified: "VerifiedForSendingStatus" in identity ? identity.VerifiedForSendingStatus : false,
    senderDkim: "DkimAttributes" in identity ? identity.DkimAttributes?.Status : ("error" in identity ? identity.error : undefined),
    sendingEnabled: account.SendingEnabled ?? false,
    productionAccess: account.ProductionAccessEnabled ?? false,
    max24HourSend: account.SendQuota?.Max24HourSend,
    sentLast24Hours: account.SendQuota?.SentLast24Hours,
    maxSendRate: account.SendQuota?.MaxSendRate,
    enforcementStatus: account.EnforcementStatus,
  };
}
