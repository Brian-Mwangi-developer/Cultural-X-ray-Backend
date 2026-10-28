import { Router } from "express";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { membershipOf } from "@/modules/orgs/access";
import { usageOf } from "@/modules/usage/usage.service";

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
