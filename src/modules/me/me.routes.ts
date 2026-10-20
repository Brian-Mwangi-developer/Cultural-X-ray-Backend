import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/infra/database";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";

export const meRouter = Router();

const PREFERENCE_DEFAULTS = {
  theme: "SYSTEM",
  density: "COMFORTABLE",
  reduceMotion: false,
  showEvidenceInline: true,
  locale: "en-US",
  region: "US",
  defaultMarket: "US",
} as const;

const preferenceSelect = {
  theme: true,
  density: true,
  reduceMotion: true,
  showEvidenceInline: true,
  locale: true,
  region: true,
  defaultMarket: true,
} as const;

meRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { user, session } = sessionOf(req);
    const [memberships, preference, credential] = await Promise.all([
      prisma.member.findMany({
        where: { userId: user.id },
        select: {
          role: true,
          allClients: true,
          organization: { select: { id: true, name: true, slug: true, kind: true, logo: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.userPreference.findUnique({ where: { userId: user.id }, select: preferenceSelect }),
      prisma.account.findFirst({ where: { userId: user.id, providerId: "credential" }, select: { id: true } }),
    ]);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, image: user.image, emailVerified: user.emailVerified, createdAt: user.createdAt },
      activeOrganizationId: session.activeOrganizationId ?? null,
      memberships: memberships.map((m) => ({ role: m.role, allClients: m.allClients, ...m.organization })),
      preferences: preference ?? PREFERENCE_DEFAULTS,
      hasPassword: Boolean(credential),
    });
  } catch (error) {
    next(error);
  }
});

const preferencesSchema = z
  .object({
    theme: z.enum(["LIGHT", "DARK", "SYSTEM"]),
    density: z.enum(["COMFORTABLE", "COMPACT"]),
    reduceMotion: z.boolean(),
    showEvidenceInline: z.boolean(),
    locale: z.enum(["en-US", "en-GB"], { message: "English (US) and English (UK) are available today." }),
    region: z.enum(["US", "GB"], { message: "Choose United States or United Kingdom." }),
    defaultMarket: z.enum(["US", "GB"], { message: "Choose United States or United Kingdom." }),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to save.");

meRouter.put("/me/preferences", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const input = preferencesSchema.parse(req.body);
    const preferences = await prisma.userPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...input },
      update: input,
      select: preferenceSelect,
    });
    res.json({ preferences });
  } catch (error) {
    next(error);
  }
});
