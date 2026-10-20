import { z } from "zod";

const access = z.enum(["VIEW", "EDIT", "MANAGE"]);
const orgKind = z.enum(["AGENCY", "WORKSPACE"]);

export const emailJobSchema = z.discriminatedUnion("template", [
  z.object({ template: z.literal("verify-email"), to: z.email(), name: z.string(), url: z.url() }),
  z.object({ template: z.literal("reset-password"), to: z.email(), name: z.string(), url: z.url() }),
  z.object({
    template: z.literal("organization-invite"),
    to: z.email(),
    inviterName: z.string(),
    inviterEmail: z.email(),
    organizationName: z.string(),
    organizationKind: orgKind,
    role: z.string(),
    url: z.url(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    template: z.literal("workspace-claim"),
    to: z.email(),
    agencyName: z.string(),
    inviterName: z.string(),
    workspaceName: z.string(),
    access,
    url: z.url(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    template: z.literal("connection-request"),
    to: z.email(),
    agencyName: z.string(),
    requesterName: z.string(),
    workspaceName: z.string(),
    access,
    url: z.url(),
  }),
  z.object({
    template: z.literal("connection-ended"),
    to: z.email(),
    agencyName: z.string(),
    workspaceName: z.string(),
    endedBy: z.enum(["AGENCY", "WORKSPACE"]),
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

/* ------------------------------------------------------------------ helpers */

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";

const longDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(iso));

export const ROLE_COPY: Record<string, { label: string; can: string }> = {
  owner: { label: "Owner", can: "Everything, including billing and deleting." },
  admin: { label: "Admin", can: "Members, clients and settings." },
  strategist: { label: "Strategist", can: "Builds maps, writes briefs and runs ad checks." },
  viewer: { label: "Viewer", can: "Reads maps and briefs." },
};

const ACCESS_COPY: Record<z.infer<typeof access>, { label: string; can: string }> = {
  VIEW: { label: "View", can: "Read maps and briefs." },
  EDIT: { label: "Edit", can: "Build maps, write briefs and run ad checks." },
  MANAGE: { label: "Manage", can: "Everything except billing, members and deleting." },
};

// Photography shared with the product's onboarding panels (Unsplash licence).
const photo = (id: string) => `https://images.unsplash.com/${id}?w=1120&h=360&fit=crop&crop=entropy&q=70&fm=jpg`;
const PHOTOS = {
  lakes: photo("photo-1615393911241-32add28288a5"),
  misty: photo("photo-1780394045649-cf8087b14c94"),
  dusk: photo("photo-1729118320039-5d5b50a16677"),
  forest: photo("photo-1761467230245-e68cff6f68e8"),
};

/* ------------------------------------------------------------------- layout */

type Row = { label: string; value: string; note?: string };

type Layout = {
  /** Short line shown in the inbox list after the subject. */
  preheader: string;
  /** Top-right label, e.g. "Agency invitation". */
  label: string;
  eyebrow: string;
  heading: string;
  /** Trusted HTML; callers escape every value they interpolate. */
  intro: string;
  image?: { src: string; alt: string };
  rows?: Row[];
  action?: { label: string; url: string };
  /** Small print under the button. */
  after?: string;
  /** Why this email arrived and what to do if it wasn't them. */
  security: string;
};

const INK = "#111113";
const INK2 = "#3F3F46";
const MUTED = "#71717A";
const FAINT = "#A1A1AA";
const BORDER = "#E4E4E7";
const WASH = "#FAFAFA";
const EMBER = "#FF6719";
const FONT = "Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Mail apps turn bare addresses into bright blue links; give them the muted style ourselves.
const noteHtml = (note: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(note)
    ? `<a href="mailto:${escape(note)}" class="x-muted" style="color:${MUTED};text-decoration:none">${escape(note)}</a>`
    : escape(note);

function detailRows(rows: Row[]): string {
  const cells = rows
    .map(
      (row, i) => `<tr>
  <td class="x-rule" style="padding:12px 18px;${i ? `border-top:1px solid ${BORDER};` : ""}font-size:13px;line-height:18px;color:${MUTED};width:118px;vertical-align:top">${escape(row.label)}</td>
  <td class="x-rule" style="padding:12px 18px 12px 0;${i ? `border-top:1px solid ${BORDER};` : ""}font-size:14px;line-height:20px;color:${INK};vertical-align:top"><span class="x-ink" style="font-weight:600;color:${INK}">${escape(row.value)}</span>${row.note ? `<br><span class="x-muted" style="font-size:13px;color:${MUTED}">${noteHtml(row.note)}</span>` : ""}</td>
</tr>`,
    )
    .join("");
  return `<tr><td style="padding:0 40px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="x-wash" style="background:${WASH};border:1px solid ${BORDER};border-radius:12px;border-collapse:separate">${cells}</table>
</td></tr>`;
}

function button(action: { label: string; url: string }): string {
  const url = escape(action.url);
  // Table-cell button: Outlook paints the cell, everything else gets the rounded link.
  return `<tr><td style="padding:0 40px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
<td align="center" bgcolor="${EMBER}" style="border-radius:999px;background:${EMBER}">
<a href="${url}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:999px">${escape(action.label)}&nbsp;&rarr;</a>
</td></tr></table>
</td></tr>
<tr><td class="x-muted" style="padding:0 40px 28px;font-size:12.5px;line-height:19px;color:${MUTED}">Button not working? Paste this into your browser:<br><a href="${url}" class="x-ink2" style="color:${INK2};text-decoration:underline;word-break:break-all">${url}</a></td></tr>`;
}

function layout(email: Layout): string {
  // Fills the inbox preview so Gmail doesn't append body text after the preheader.
  const preheaderPad = "&#847;&zwnj;&nbsp;".repeat(140);
  const image = email.image
    ? `<tr><td style="padding:0"><img src="${escape(email.image.src)}" width="560" alt="${escape(email.image.alt)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:15px 15px 0 0;background:#E4E4E7"></td></tr>`
    : "";
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(email.heading)}</title>
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%}
  a{color:inherit}
  @media (max-width:600px){
    .x-pad{padding-left:24px!important;padding-right:24px!important}
    .x-card td{padding-left:24px!important;padding-right:24px!important}
    .x-card td td{padding-left:16px!important;padding-right:16px!important}
    .x-h1{font-size:24px!important;line-height:30px!important}
  }
  @media (prefers-color-scheme:dark){
    .x-body{background:#0B0B0C!important}
    .x-card{background:#161618!important;border-color:#27272A!important}
    .x-wash{background:#1B1B1E!important;border-color:#27272A!important}
    .x-rule{border-color:#27272A!important}
    .x-ink{color:#FAFAFA!important}
    .x-ink2{color:#D4D4D8!important}
    .x-muted{color:#A1A1AA!important}
    .x-faint{color:#71717A!important}
  }
</style>
</head>
<body class="x-body" style="margin:0;padding:0;background:#F4F4F5;font-family:${FONT};color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escape(email.preheader)}${preheaderPad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="x-body" style="background:#F4F4F5">
<tr><td align="center" class="x-pad" style="padding:40px 16px">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 18px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:${INK}" class="x-ink"><span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${EMBER};margin-right:8px;vertical-align:0"></span>Cultural <span class="x-muted" style="font-weight:400;color:${MUTED}">X-Ray</span></td>
    <td align="right" class="x-muted" style="font-size:12px;line-height:20px;color:${MUTED}">${escape(email.label)}</td>
  </tr></table>
</td></tr>
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="x-card" style="max-width:560px;background:#FFFFFF;border:1px solid ${BORDER};border-radius:16px;border-collapse:separate">
${image}
<tr><td style="padding:${email.image ? "32px" : "40px"} 40px 0">
  <p style="margin:0 0 14px;font-size:11.5px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${EMBER}">&#9679;&nbsp; ${escape(email.eyebrow)}</p>
  <h1 class="x-h1 x-ink" style="margin:0 0 14px;font-size:28px;line-height:34px;font-weight:600;letter-spacing:-0.025em;color:${INK}">${escape(email.heading)}</h1>
  <p class="x-ink2" style="margin:0 0 28px;font-size:15px;line-height:24px;color:${INK2}">${email.intro}</p>
</td></tr>
${email.rows?.length ? detailRows(email.rows) : ""}
${email.action ? button(email.action) : ""}
${email.after ? `<tr><td class="x-muted" style="padding:0 40px 28px;font-size:13px;line-height:20px;color:${MUTED}">${email.after}</td></tr>` : ""}
<tr><td style="padding:0 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="x-rule" style="height:0;line-height:0;font-size:0;border-top:1px solid ${BORDER}">&nbsp;</td></tr></table></td></tr>
<tr><td class="x-muted" style="padding:20px 40px 32px;font-size:12.5px;line-height:19px;color:${MUTED}">${email.security}</td></tr>
</table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td class="x-faint" style="padding:22px 4px 0;font-size:12px;line-height:18px;color:${FAINT}">
  Cultural X-Ray reads the culture around a brand from Qloo&rsquo;s taste graph: what its customers listen to, watch, follow and travel to.<br>
  This is a service email about your account, so it has no unsubscribe link.
</td></tr>
</table>

</td></tr>
</table>
</body>
</html>`;
}

function textVersion(lines: (string | false | undefined)[]): string {
  return [...lines.filter(Boolean), "", "—", "Cultural X-Ray"].join("\n");
}

/* ---------------------------------------------------------------- templates */

/** Where the confirmation link sends them, so the email can say what comes next. */
function verifyIntent(url: string): "agency" | "brand" | "invite" | "claim" | "other" {
  try {
    const callback = new URL(url).searchParams.get("callbackURL") ?? "";
    if (callback.startsWith("/invite/")) return "invite";
    if (callback.startsWith("/claim/")) return "claim";
    if (callback.includes("kind=agency")) return "agency";
    if (callback.includes("kind=brand")) return "brand";
  } catch {
    // An unparseable URL still gets the general copy.
  }
  return "other";
}

const NEXT_STEP: Record<ReturnType<typeof verifyIntent>, string> = {
  agency: "Next, you'll name your agency and bring in your team. It takes about two minutes.",
  brand: "Next, you'll tell us your brand and who to compare it with. Your first map takes about a minute.",
  invite: "Then you'll land on the invitation that's waiting for you.",
  claim: "Then you'll land on the workspace that's waiting for you to claim.",
  other: "Then you'll set up your agency or your brand's workspace.",
};

export function render(job: EmailJob): RenderedEmail {
  switch (job.template) {
    case "verify-email": {
      const next = NEXT_STEP[verifyIntent(job.url)];
      return {
        subject: "Confirm your email for Cultural X-Ray",
        html: layout({
          preheader: "One click and your account is ready.",
          label: "Confirm your email",
          eyebrow: "One step left",
          heading: "Confirm your email",
          intro: `Hi ${escape(firstName(job.name))}, confirm this address and you're in. ${escape(next)}`,
          image: { src: PHOTOS.lakes, alt: "A lake below green mountains" },
          rows: [
            { label: "Account", value: job.to },
            { label: "Link works for", value: "24 hours", note: "One use. Ask for a new one from the login page any time." },
          ],
          action: { label: "Confirm email", url: job.url },
          security: `You're getting this because someone signed up for Cultural X-Ray with <span class="x-ink2" style="color:${INK2}">${escape(job.to)}</span>. If it wasn't you, ignore this email and no account will be created.`,
        }),
        text: textVersion([
          `Hi ${firstName(job.name)},`,
          "",
          `Confirm your email for Cultural X-Ray and you're in. ${next}`,
          "",
          `Confirm: ${job.url}`,
          "",
          "The link works once, for 24 hours.",
          `If you didn't sign up with ${job.to}, ignore this email.`,
        ]),
      };
    }

    case "reset-password":
      return {
        subject: "Reset your Cultural X-Ray password",
        html: layout({
          preheader: "Choose a new password. The link works for one hour.",
          label: "Security",
          eyebrow: "Password reset",
          heading: "Choose a new password",
          intro: `Hi ${escape(firstName(job.name))}, someone asked to reset the password for your account. If that was you, choose a new one below.`,
          rows: [
            { label: "Account", value: job.to },
            { label: "Link works for", value: "1 hour", note: "One use. Your current password keeps working until you change it." },
          ],
          action: { label: "Choose a new password", url: job.url },
          security: `Didn't ask for this? Ignore this email; nothing changes. If you get several of these you didn't request, reply and we'll look into it.`,
        }),
        text: textVersion([
          `Hi ${firstName(job.name)},`,
          "",
          "Someone asked to reset the password for your Cultural X-Ray account. If that was you, choose a new one (link works once, for one hour):",
          job.url,
          "",
          "Didn't ask for this? Ignore this email; nothing changes.",
        ]),
      };

    case "organization-invite": {
      const role = ROLE_COPY[job.role] ?? { label: job.role, can: "" };
      const place = job.organizationKind === "AGENCY" ? "agency" : "workspace";
      return {
        subject: `${job.inviterName} invited you to ${job.organizationName} on Cultural X-Ray`,
        html: layout({
          preheader: `Join as ${role.label}. ${role.can}`,
          label: job.organizationKind === "AGENCY" ? "Agency invitation" : "Workspace invitation",
          eyebrow: `You're invited`,
          heading: `Join ${job.organizationName}`,
          intro: `${escape(job.inviterName)} invited you to work with them in <strong class="x-ink" style="color:${INK}">${escape(job.organizationName)}</strong>, their ${place} on Cultural X-Ray, where teams map the culture around a brand and turn it into briefs.`,
          image: { src: PHOTOS.misty, alt: "Mist over a mountain ridge" },
          rows: [
            { label: job.organizationKind === "AGENCY" ? "Agency" : "Workspace", value: job.organizationName },
            { label: "Your role", value: role.label, note: role.can },
            { label: "Invited by", value: job.inviterName, note: job.inviterEmail },
            { label: "Expires", value: longDate(job.expiresAt) },
          ],
          action: { label: `Join ${job.organizationName}`, url: job.url },
          after: `New to Cultural X-Ray? You'll create an account with <span class="x-ink2" style="color:${INK2}">${escape(job.to)}</span> first.`,
          security: `This invitation was sent to ${escape(job.to)} and only works for that address. Not expecting it? Ignore it; it expires on its own.`,
        }),
        text: textVersion([
          `${job.inviterName} (${job.inviterEmail}) invited you to ${job.organizationName} on Cultural X-Ray.`,
          "",
          `Your role: ${role.label}. ${role.can}`,
          `Expires: ${longDate(job.expiresAt)}`,
          "",
          `Join: ${job.url}`,
          "",
          `The invitation only works for ${job.to}. Not expecting it? Ignore it.`,
        ]),
      };
    }

    case "workspace-claim": {
      const level = ACCESS_COPY[job.access];
      return {
        subject: `${job.agencyName} set up ${job.workspaceName} on Cultural X-Ray for you`,
        html: layout({
          preheader: `Claim it to become the owner. You decide what ${job.agencyName} can do.`,
          label: "Workspace ready to claim",
          eyebrow: "Yours to claim",
          heading: `${job.agencyName} set up ${job.workspaceName} for you`,
          intro: `${escape(job.inviterName)} at ${escape(job.agencyName)} created a Cultural X-Ray workspace for <strong class="x-ink" style="color:${INK}">${escape(job.workspaceName)}</strong>. Claim it and you become the owner: the maps, briefs and settings they made come with it, and you choose what they can keep doing.`,
          image: { src: PHOTOS.dusk, alt: "Red canyon walls at dusk" },
          rows: [
            { label: "Workspace", value: job.workspaceName },
            { label: "Set up by", value: job.agencyName, note: job.inviterName },
            { label: "Access asked", value: level.label, note: `${level.can} You can lower it when you claim.` },
            { label: "Claim by", value: longDate(job.expiresAt) },
          ],
          action: { label: `Review and claim`, url: job.url },
          after: `You can remove ${escape(job.agencyName)} at any time and keep everything.`,
          security: `This link was sent to ${escape(job.to)} and only works for that address. Not you? Ignore it, or decline from the page and ${escape(job.agencyName)} is told.`,
        }),
        text: textVersion([
          `${job.inviterName} at ${job.agencyName} set up a Cultural X-Ray workspace for ${job.workspaceName}.`,
          "",
          "Claim it to become the owner. The maps, briefs and settings they made come with it.",
          `Access they asked for: ${level.label} (${level.can}) You can lower it when you claim.`,
          `Claim by: ${longDate(job.expiresAt)}`,
          "",
          `Review and claim: ${job.url}`,
        ]),
      };
    }

    case "connection-request": {
      const level = ACCESS_COPY[job.access];
      return {
        subject: `${job.agencyName} asked to work in ${job.workspaceName}`,
        html: layout({
          preheader: `They asked for ${level.label} access. Nothing changes until you approve.`,
          label: "Agency request",
          eyebrow: "Needs your decision",
          heading: `${job.agencyName} wants to work in ${job.workspaceName}`,
          intro: `${escape(job.requesterName)} at ${escape(job.agencyName)} used your workspace code to ask for access. Nothing changes until you approve, and you can lower the access before you do.`,
          image: { src: PHOTOS.forest, alt: "A path through a green forest" },
          rows: [
            { label: "Agency", value: job.agencyName, note: job.requesterName },
            { label: "Access asked", value: level.label, note: level.can },
            { label: "Workspace", value: job.workspaceName },
          ],
          action: { label: "Review request", url: job.url },
          after: "Everything an agency makes stays in your workspace, even after they leave.",
          security: `You're getting this because you own or manage ${escape(job.workspaceName)}. Don't recognise ${escape(job.agencyName)}? Decline the request and change your workspace code in Settings.`,
        }),
        text: textVersion([
          `${job.requesterName} at ${job.agencyName} asked to work in ${job.workspaceName}.`,
          `Access asked: ${level.label} (${level.can})`,
          "Nothing changes until you approve.",
          "",
          `Review: ${job.url}`,
        ]),
      };
    }

    case "connection-ended": {
      const byAgency = job.endedBy === "AGENCY";
      return {
        subject: `${job.agencyName} is no longer connected to ${job.workspaceName}`,
        html: layout({
          preheader: byAgency ? `${job.workspaceName} keeps its workspace and everything in it.` : `Your team's access to ${job.workspaceName} has ended.`,
          label: "Connection ended",
          eyebrow: "For your records",
          heading: `${job.agencyName} and ${job.workspaceName} are no longer connected`,
          intro: byAgency
            ? `${escape(job.agencyName)} disconnected from <strong class="x-ink" style="color:${INK}">${escape(job.workspaceName)}</strong>. The workspace and everything in it, including the maps and briefs they made, stays with you.`
            : `${escape(job.workspaceName)} removed ${escape(job.agencyName)} from their workspace. Your team's access ended straight away; their maps and briefs stay with them.`,
          action: { label: byAgency ? "Open your workspace" : "Open Cultural X-Ray", url: job.url },
          security: "You're getting this because you own or manage one side of this connection.",
        }),
        text: textVersion([
          `${job.agencyName} and ${job.workspaceName} are no longer connected.`,
          byAgency ? `${job.workspaceName} keeps its workspace and everything in it.` : `${job.agencyName}'s access has ended.`,
          "",
          job.url,
        ]),
      };
    }

    case "plain":
      return {
        subject: job.subject,
        html: layout({
          preheader: job.text.slice(0, 90),
          label: "Message",
          eyebrow: "Cultural X-Ray",
          heading: job.subject,
          intro: escape(job.text).replace(/\n/g, "<br>"),
          security: "You're getting this because of your Cultural X-Ray account.",
        }),
        text: textVersion([job.text]),
      };
  }
}
