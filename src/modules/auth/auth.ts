import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { enqueueEmail } from "@/modules/email/email.queue";
import { redisSecondaryStorage } from "@/modules/auth/session-store";

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
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => {
      await enqueueEmail({ template: "reset-password", to: user.email, name: user.name, url }, { priority: 9 });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await enqueueEmail({ template: "verify-email", to: user.email, name: user.name, url }, { priority: 9 });
    },
  },

  ...(google && { socialProviders: google }),

  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
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
      sendInvitationEmail: async ({ id, email, role, organization: org, inviter }) => {
        await enqueueEmail({
          template: "organization-invite",
          to: email,
          inviterName: inviter.user.name,
          organizationName: org.name,
          role,
          url: `${config.http.publicWebUrl}/invite/${id}`,
        });
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
