import { Router } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { workspaceAccess } from "@/modules/orgs/access";
import { GOALS } from "@/modules/guide/guide.steps";
import { guideOf, MARK_KEY, personOf, setMarks, welcome } from "@/modules/guide/guide.service";

export const guideRouter = Router();

/** The welcome room: whether this person has been through it, and the goal they picked. */
guideRouter.get("/me/guide", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    res.set("Cache-Control", "no-store").json(await personOf(user.id));
  } catch (error) {
    next(error);
  }
});

const welcomeSchema = z.object({ goal: z.enum(GOALS as [string, ...string[]]).nullable() });

guideRouter.put("/me/guide", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { goal } = welcomeSchema.parse(req.body);
    await welcome(user.id, goal as never);
    res.json(await personOf(user.id));
  } catch (error) {
    next(error);
  }
});

/** Steps ticked by real work, the next one, what changed since the last visit, and this person's marks. */
guideRouter.get("/orgs/:id/guide", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ guide: await guideOf(user.id, { id: organization.id, kind: organization.kind }) });
  } catch (error) {
    next(error);
  }
});

const key = z.string().max(48).regex(MARK_KEY, "That isn't a guide mark.");
const marksSchema = z.object({
  add: z.array(key).max(10).default([]),
  // "tour:*" clears every tour, for "Show the tours again".
  remove: z.array(z.union([key, z.literal("tour:*"), z.literal("seen:*")])).max(10).default([]),
});

guideRouter.put("/orgs/:id/guide/marks", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    const { add, remove } = marksSchema.parse(req.body);
    await setMarks(user.id, organization.id, add, remove);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
