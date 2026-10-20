import { Router } from "express";
import { prisma } from "@/infra/database";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";

export const meRouter = Router();

meRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { user, session } = sessionOf(req);
    const memberships = await prisma.member.findMany({
      where: { userId: user.id },
      select: {
        role: true,
        allClients: true,
        organization: { select: { id: true, name: true, slug: true, kind: true, logo: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({
      user: { id: user.id, name: user.name, email: user.email, image: user.image, emailVerified: user.emailVerified },
      activeOrganizationId: session.activeOrganizationId ?? null,
      memberships: memberships.map((m) => ({ role: m.role, allClients: m.allClients, ...m.organization })),
    });
  } catch (error) {
    next(error);
  }
});
