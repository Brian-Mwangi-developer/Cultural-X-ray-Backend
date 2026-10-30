import { Router } from "express";
import { z } from "zod";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { requireRole, workspaceAccess } from "@/modules/orgs/access";
import { PLACEMENTS } from "@/modules/adcheck/adcheck.service";
import { briefOf, deleteBrief, listBriefs, saveBrief, shareBrief, sharedBrief, writeBrief } from "@/modules/briefs/brief.service";
import { SECTIONS } from "@/modules/briefs/brief.write";

export const briefsRouter = Router();
const WRITERS = ["owner", "admin", "strategist"] as const;

briefsRouter.get("/orgs/:id/briefs", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ briefs: await listBriefs(organization.id) });
  } catch (error) {
    next(error);
  }
});

const writeSchema = z.object({
  occasion: z.string().trim().min(2, "Say what the brief is for.").max(120),
  placements: z.array(z.enum(PLACEMENTS)).max(8).default([]),
});

/** Write a brief from the map. Waits for it (about 10–20 s). An agency writing for a client is recorded as the author. */
briefsRouter.post("/orgs/:id/briefs", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const access = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(access.member.role, WRITERS, "write briefs");
    const input = writeSchema.parse(req.body);
    const brief = await writeBrief(access.organization.id, user.id, access.agencyId ?? access.organization.id, input);
    res.status(201).json({ brief });
  } catch (error) {
    next(error);
  }
});

briefsRouter.get("/orgs/:id/briefs/:briefId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ brief: await briefOf(organization.id, String(req.params.briefId)) });
  } catch (error) {
    next(error);
  }
});

const saveSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  occasion: z.string().trim().max(120).optional(),
  items: z.array(z.object({ id: z.string().max(40).optional(), section: z.enum(SECTIONS), text: z.string().max(600) })).max(60).optional(),
});

briefsRouter.put("/orgs/:id/briefs/:briefId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "edit briefs");
    res.json({ brief: await saveBrief(organization.id, String(req.params.briefId), saveSchema.parse(req.body)) });
  } catch (error) {
    next(error);
  }
});

briefsRouter.delete("/orgs/:id/briefs/:briefId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "delete briefs");
    await deleteBrief(organization.id, String(req.params.briefId));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** Turn the read-only link on or off. */
briefsRouter.put("/orgs/:id/briefs/:briefId/share", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "share briefs");
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    res.json({ shareToken: await shareBrief(organization.id, String(req.params.briefId), on) });
  } catch (error) {
    next(error);
  }
});

/** Anyone with the link: the brief, read-only. No session needed. */
briefsRouter.get("/shared/briefs/:token", async (req, res, next) => {
  try {
    const token = z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/).parse(req.params.token);
    res.set("Cache-Control", "no-store").json({ brief: await sharedBrief(token) });
  } catch (error) {
    next(error);
  }
});
