import { Router } from "express";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { membershipOf } from "@/modules/orgs/access";
import { aiSpendOf, usageOf } from "@/modules/usage/usage.service";
import { MANAGER_ROLES } from "@/modules/auth/roles";

export const usageRouter = Router();

/** Qloo queries used this month and the allowance. Members of the account read it (the sidebar meter, Settings › Usage). */
usageRouter.get("/orgs/:id/usage", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await membershipOf(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ usage: await usageOf(organization.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * This month's Gemini cost (ad checks, talking to X-Ray) by person and by activity. Owners and admins
 * see everyone; other members see only their own line.
 */
usageRouter.get("/orgs/:id/usage/ai", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    const spend = await aiSpendOf({ id: organization.id, kind: organization.kind });
    const manager = (MANAGER_ROLES as string[]).includes(member.role);
    res.set("Cache-Control", "no-store").json({
      spend: manager ? { ...spend, everyone: true } : { since: spend.since, everyone: false, totalMicros: null, byActivity: [], byPerson: spend.byPerson.filter((p) => p.userId === user.id) },
    });
  } catch (error) {
    next(error);
  }
});
