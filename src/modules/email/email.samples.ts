import { config } from "@/config/env";
import type { EmailJob, EmailTemplate } from "@/modules/email/email.templates";

/** Realistic sample data per template, for design review in a real inbox. Links point at this app. */
export function sampleEmail(template: Exclude<EmailTemplate, "plain">, to: string): EmailJob {
  const web = config.http.publicWebUrl;
  const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  switch (template) {
    case "verify-email":
      return { template, to, name: "Tomás Reyes", url: `${web}/login?sample=verify` };
    case "reset-password":
      return { template, to, name: "Tomás Reyes", url: `${web}/login?sample=reset` };
    case "organization-invite":
      return { template, to, inviterName: "Tomás Reyes", inviterEmail: "tomas@harborandpine.com", organizationName: "Harbor & Pine", organizationKind: "AGENCY", role: "strategist", url: `${web}/login?sample=invite`, expiresAt: inAWeek };
    case "workspace-claim":
      return { template, to, agencyName: "Harbor & Pine", inviterName: "Tomás Reyes", workspaceName: "Starbucks", access: "MANAGE", url: `${web}/login?sample=claim`, expiresAt: inAWeek };
    case "connection-request":
      return { template, to, agencyName: "Tidewater Studio", requesterName: "Sam Okoro", workspaceName: "Northline Outdoor", access: "VIEW", url: `${web}/login?sample=request` };
    case "connection-ended":
      return { template, to, agencyName: "Harbor & Pine", workspaceName: "Patagonia", endedBy: "AGENCY", url: `${web}/login?sample=ended` };
  }
}

export const SAMPLE_TEMPLATES = ["verify-email", "reset-password", "organization-invite", "workspace-claim", "connection-request", "connection-ended"] as const;
