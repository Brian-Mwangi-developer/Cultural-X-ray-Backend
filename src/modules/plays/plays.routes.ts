import { Router } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { creatorDetail, creatorsFor, outreachDraft } from "@/modules/creators/creators.service";
import { basisOf } from "@/modules/maps/map.basis";
import { requireRole, workspaceAccess } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import { listPlays, playDetail, requestPlays } from "@/modules/plays/plays.service";

export const playsRouter = Router();

const WRITERS = ["owner", "admin", "strategist"] as const;

/** Plays from the latest ready map, and whether new ones are being written. Any member (or connected agency) reads them. */
playsRouter.get("/orgs/:id/plays", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ ...(await listPlays(organization.id)), basis: await basisOf(organization.id) });
  } catch (error) {
    next(error);
  }
});

/** Rewrite the plays in the worker (202). */
playsRouter.post("/orgs/:id/plays/refresh", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "refresh plays");
    await requestPlays(organization.id, user.id);
    void audit({ organizationId: organization.id, actorId: user.id, action: "plays.refresh", targetType: "organization", targetId: organization.id }).catch(() => undefined);
    res.status(202).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

playsRouter.get("/orgs/:id/plays/:playId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ ...(await playDetail(organization.id, String(req.params.playId))), basis: await basisOf(organization.id) });
  } catch (error) {
    next(error);
  }
});

/** Creators on the map, a play's own first, with their confirmed channels and latest videos. */
playsRouter.get("/orgs/:id/creators", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    const play = typeof req.query.play === "string" ? req.query.play : undefined;
    res.set("Cache-Control", "no-store").json({ ...(await creatorsFor(organization.id, play)), basis: await basisOf(organization.id) });
  } catch (error) {
    next(error);
  }
});

playsRouter.get("/orgs/:id/creators/:entityId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ ...(await creatorDetail(organization.id, String(req.params.entityId))), basis: await basisOf(organization.id) });
  } catch (error) {
    next(error);
  }
});

const outreachBody = z.object({ playId: z.string().min(1).nullish() }).default({});

/** A first message to a creator, to copy and send yourself. Nothing is sent from here. */
playsRouter.post("/orgs/:id/creators/:entityId/outreach", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "draft outreach");
    const { playId } = outreachBody.parse(req.body ?? {});
    const draft = await outreachDraft(organization.id, String(req.params.entityId), playId ?? null, { feature: "PLAYS", userId: user.id, workspaceId: organization.id, name: user.name });
    res.json({ draft });
  } catch (error) {
    next(error);
  }
});
