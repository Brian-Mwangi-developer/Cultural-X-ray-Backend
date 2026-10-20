import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { enqueueEmail } from "@/modules/email/email.queue";
import { redisSecondaryStorage } from "@/modules/auth/session-store";
import { ac, INVITABLE_ROLES, roles } from "@/modules/auth/roles";
import { newConnectCode } from "@/modules/orgs/connect-code";
import { slugProblem } from "@/modules/orgs/slugs";

const google = config.auth.google.clientId && config.auth.google.clientSecret ? { google: { ...config.auth.google } } : undefined;

export const auth = betterAuth({
  appName: "Cultural X-Ray",
  baseURL: config.auth.baseUrl,
  secret: config.auth.secret,
  trustedOrigins: config.http.webOrigins,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secondaryStorage: redisSecondaryStorage,

  session: {
    storeSessionInDatabase: true,
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 300, max: 5 },
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    // No session until the address is confirmed; the confirmation link signs you in.
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await enqueueEmail({ template: "reset-password", to: user.email, name: user.name, url }, { priority: 9 });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    expiresIn: 60 * 60 * 24,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await enqueueEmail({ template: "verify-email", to: user.email, name: user.name, url }, { priority: 9 });
    },
  },

  ...(google && { socialProviders: google }),

  plugins: [
    organization({
      ac,
      roles,
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: true,
      invitationExpiresIn: 60 * 60 * 24 * 7,
      schema: {
        organization: {
          additionalFields: {
            kind: { type: "string", required: true, input: true },
            hqCountry: { type: "string", required: false, input: true },
            teamSize: { type: "string", required: false, input: true },
            billingEmail: { type: "string", required: false, input: true },
          },
        },
        member: { additionalFields: { allClients: { type: "boolean", required: false, defaultValue: true, input: false } } },
        invitation: { additionalFields: { allClients: { type: "boolean", required: false, defaultValue: true, input: true } } },
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization: org }) => {
          if (org.kind !== "AGENCY" && org.kind !== "WORKSPACE") {
            throw new APIError("BAD_REQUEST", { code: "XRAY_INVALID_KIND", message: "Choose an agency or a brand workspace." });
          }
          const problem = slugProblem(String(org.slug ?? ""));
          if (problem) throw new APIError("BAD_REQUEST", { code: "XRAY_INVALID_SLUG", message: problem });
          const name = String(org.name ?? "").trim();
          if (name.length < 2 || name.length > 80) {
            throw new APIError("BAD_REQUEST", { code: "XRAY_INVALID_NAME", message: "Use a name between 2 and 80 characters." });
          }
          return { data: { ...org, name } };
        },
        afterCreateOrganization: async ({ organization: org }) => {
          if (org.kind === "WORKSPACE") {
            await prisma.organization.update({ where: { id: org.id }, data: { connectCode: await newConnectCode(org.name) } });
          }
        },
        beforeUpdateOrganization: async ({ organization: org }) => {
          if (org.slug !== undefined) {
            const problem = slugProblem(String(org.slug));
            if (problem) throw new APIError("BAD_REQUEST", { code: "XRAY_INVALID_SLUG", message: problem });
          }
          if (org.name !== undefined && (String(org.name).trim().length < 2 || String(org.name).trim().length > 80)) {
            throw new APIError("BAD_REQUEST", { code: "XRAY_INVALID_NAME", message: "Use a name between 2 and 80 characters." });
          }
          if ("kind" in org && org.kind !== undefined) {
            throw new APIError("BAD_REQUEST", { code: "XRAY_KIND_FIXED", message: "An agency can't become a workspace, or the other way round." });
          }
        },
        beforeDeleteOrganization: async ({ organization: org }) => {
          if ((org as { kind?: string }).kind !== "AGENCY") return;
          const waiting = await prisma.workspaceClaim.count({ where: { agencyId: org.id, status: "PENDING", expiresAt: { gt: new Date() } } });
          if (waiting > 0) {
            throw new APIError("BAD_REQUEST", {
              code: "XRAY_UNCLAIMED_CLIENTS",
              message: `${waiting === 1 ? "A client workspace is" : `${waiting} client workspaces are`} still waiting to be claimed. Deleting now would leave ${waiting === 1 ? "it" : "them"} without an owner, so ask ${waiting === 1 ? "its owner" : "their owners"} to claim first.`,
            });
          }
        },
        beforeCreateInvitation: async ({ invitation }) => {
          if (!INVITABLE_ROLES.includes(invitation.role as (typeof INVITABLE_ROLES)[number])) {
            throw new APIError("BAD_REQUEST", { code: "XRAY_INVALID_ROLE", message: "Invite people as Admin, Strategist or Viewer." });
          }
        },
      },
      sendInvitationEmail: async ({ id, email, role, organization: org, inviter, invitation }) => {
        await enqueueEmail({
          template: "organization-invite",
          to: email,
          inviterName: inviter.user.name,
          inviterEmail: inviter.user.email,
          organizationName: org.name,
          organizationKind: (org as { kind?: string }).kind === "AGENCY" ? "AGENCY" : "WORKSPACE",
          role,
          url: `${config.http.publicWebUrl}/invite/${id}`,
          expiresAt: new Date(invitation.expiresAt).toISOString(),
        });
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
