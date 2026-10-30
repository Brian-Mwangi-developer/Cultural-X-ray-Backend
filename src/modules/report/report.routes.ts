import { Router } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { requireRole, workspaceAccess } from "@/modules/orgs/access";
import { reportOf, sharedReport, shareReport } from "@/modules/report/report.service";

export const reportRouter = Router();

/** The culture report for a brand: any member or connected agency reads it. */
reportRouter.get("/orgs/:id/report", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ report: await reportOf(organization.id) });
  } catch (error) {
    next(error);
  }
});

/** Turn the read-only report link on (a fresh token) or off. */
reportRouter.put("/orgs/:id/report/share", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, ["owner", "admin", "strategist"], "share the report");
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    res.json({ shareToken: await shareReport(organization.id, on) });
  } catch (error) {
    next(error);
  }
});

/** Anyone with the link: the report, read-only. */
reportRouter.get("/shared/reports/:token", async (req, res, next) => {
  try {
    const token = z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/).parse(req.params.token);
    res.set("Cache-Control", "no-store").json({ report: await sharedReport(token) });
  } catch (error) {
    next(error);
  }
});
