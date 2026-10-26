import { Router } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { requireRole, workspaceAccess } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import { audienceOf, latestMap, startBuild } from "@/modules/maps/map.service";

export const mapsRouter = Router();

const buildSchema = z.object({ rebuild: z.boolean().default(false) }).default({ rebuild: false });

/** Start the workspace's map (or return the one already building). 202: the worker does the work. */
mapsRouter.post("/orgs/:id/maps", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, ["owner", "admin", "strategist"], "build maps");
    const { rebuild } = buildSchema.parse(req.body ?? {});
    const map = await startBuild(organization.id, user.id, { rebuild });
    void audit({ organizationId: organization.id, actorId: user.id, action: "map.build", targetType: "culture_map", targetId: map.id, data: { rebuild } }).catch(() => undefined);
    res.status(202).json({ map });
  } catch (error) {
    next(error);
  }
});

/** The latest map with progress, readings and the top items per category. Any member can read it. */
mapsRouter.get("/orgs/:id/maps/latest", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ map: await latestMap(organization.id) });
  } catch (error) {
    next(error);
  }
});

/** Who each brand reaches and where, from the latest ready map. Any member can read it. */
mapsRouter.get("/orgs/:id/maps/latest/audience", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ audience: await audienceOf(organization.id) });
  } catch (error) {
    next(error);
  }
});
