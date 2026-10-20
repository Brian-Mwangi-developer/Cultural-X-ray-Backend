import { z } from "zod";

export const emailJobSchema = z.discriminatedUnion("template", [
  z.object({ template: z.literal("verify-email"), to: z.email(), name: z.string(), url: z.url() }),
  z.object({ template: z.literal("reset-password"), to: z.email(), name: z.string(), url: z.url() }),
  z.object({
    template: z.literal("organization-invite"),
    to: z.email(),
    inviterName: z.string(),
    organizationName: z.string(),
    role: z.string(),
    url: z.url(),
  }),
  z.object({
    template: z.literal("workspace-claim"),
    to: z.email(),
    agencyName: z.string(),
    workspaceName: z.string(),
    url: z.url(),
  }),
  z.object({ template: z.literal("plain"), to: z.email(), subject: z.string().min(1), text: z.string().min(1) }),
]);

export type EmailJob = z.infer<typeof emailJobSchema>;
export type EmailTemplate = EmailJob["template"];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function layout(heading: string, body: string, action?: { label: string; url: string }): string {
  const button = action
    ? `<tr><td style="padding:8px 0 24px"><a href="${escape(action.url)}" style="display:inline-block;background:#FF6719;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">${escape(action.label)}</a></td></tr>
       <tr><td style="font-size:12.5px;color:#71717A;padding-bottom:8px">Or paste this link into your browser:<br><span style="color:#3F3F46;word-break:break-all">${escape(action.url)}</span></td></tr>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)}</title></head>
<body style="margin:0;background:#F4F4F5;font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#111113">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F5;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E4E4E7;border-radius:16px;padding:32px">
<tr><td style="font-size:15px;font-weight:600;padding-bottom:24px"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#FF6719;margin-right:8px"></span>Cultural X-Ray</td></tr>
<tr><td style="font-size:24px;font-weight:600;letter-spacing:-0.02em;padding-bottom:12px">${escape(heading)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#3F3F46;padding-bottom:20px">${body}</td></tr>
${button}
</table>
<p style="font-size:12px;color:#A1A1AA;margin:16px 0 0">You received this because of an action on Cultural X-Ray. If it wasn’t you, ignore this email.</p>
</td></tr></table></body></html>`;
}

export function render(job: EmailJob): RenderedEmail {
  switch (job.template) {
    case "verify-email":
      return {
        subject: "Confirm your email for Cultural X-Ray",
        html: layout("Confirm your email", `Hi ${escape(job.name)}, confirm this address to finish setting up your account.`, { label: "Confirm email", url: job.url }),
        text: `Hi ${job.name}, confirm your email for Cultural X-Ray: ${job.url}`,
      };
    case "reset-password":
      return {
        subject: "Reset your Cultural X-Ray password",
        html: layout("Reset your password", `Hi ${escape(job.name)}, use the button below to choose a new password. The link expires in an hour.`, { label: "Choose a new password", url: job.url }),
        text: `Hi ${job.name}, reset your Cultural X-Ray password (expires in an hour): ${job.url}`,
      };
    case "organization-invite":
      return {
        subject: `${job.inviterName} invited you to ${job.organizationName}`,
        html: layout(`Join ${escape(job.organizationName)}`, `${escape(job.inviterName)} invited you to ${escape(job.organizationName)} on Cultural X-Ray as <strong>${escape(job.role)}</strong>.`, { label: "Accept invitation", url: job.url }),
        text: `${job.inviterName} invited you to ${job.organizationName} on Cultural X-Ray as ${job.role}: ${job.url}`,
      };
    case "workspace-claim":
      return {
        subject: `${job.agencyName} set up ${job.workspaceName} for you`,
        html: layout(`Claim ${escape(job.workspaceName)}`, `${escape(job.agencyName)} set up a Cultural X-Ray workspace for ${escape(job.workspaceName)}. Claim it to become the owner; you choose what access the agency keeps.`, { label: "Claim workspace", url: job.url }),
        text: `${job.agencyName} set up a Cultural X-Ray workspace for ${job.workspaceName}. Claim it: ${job.url}`,
      };
    case "plain":
      return { subject: job.subject, html: layout(job.subject, escape(job.text).replace(/\n/g, "<br>")), text: job.text };
  }
}
