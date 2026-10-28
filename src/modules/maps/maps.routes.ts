import { Router } from "express";
import { z } from "zod";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { ensureEntities } from "@/modules/lookup/lookup.service";
import { requireRole, workspaceAccess } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import { audienceOf, latestMap, startBuild } from "@/modules/maps/map.service";
import { parseView, requestView, territoryView } from "@/modules/maps/map.view";

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

/** One category of the map under the chosen filters (age, mainstream or niche). Any member or connected agency reads it. */
mapsRouter.get("/orgs/:id/maps/latest/territory", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json(await territoryView(organization.id, parseView(req.query)));
  } catch (error) {
    next(error);
  }
});

/**
 * Build a filtered view (202). Anyone who can read the map can ask for one: it is a way of reading
 * it, and it costs about one Qloo query per brand compared, counted on the account's meter.
 */
mapsRouter.post("/orgs/:id/maps/latest/territory", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    res.status(202).json(await requestView(organization.id, user.id, parseView({ ...req.query, ...(req.body ?? {}) })));
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ who the map compares with */

const comparePick = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(120), kind: z.enum(["brand", "place"]), categories: z.array(z.string().max(80)).max(5).optional(), detail: z.string().max(200).optional() });
const compareSchema = z.object({
  /** The brands to win customers from. */
  rivals: z.array(comparePick).max(3),
  /** Brands like this one whose customers the map reads through (or fill out a known brand's data). */
  seeds: z.array(comparePick).max(3),
});

/**
 * Change who the map compares with (Figma 13 · K2), then rebuild it (202). Every pick must be one
 * Qloo search returned, as in onboarding; a brand Qloo doesn't know needs at least one brand to read
 * through. Plays, ad checks, creators and Ask X-Ray read the set from the new map once it's ready.
 */
mapsRouter.put("/orgs/:id/compare", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await workspaceAccess(user.id, { id: String(req.params.id) });
    requireRole(member.role, ["owner", "admin", "strategist"], "change who the map compares with");
    const input = compareSchema.parse(req.body);
    const ids = [...input.rivals, ...input.seeds].map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "A brand can be a rival or read through, not both.", { code: "COMPARE_TWICE" });

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { metadata: true, brandEntityId: true } });
    if (org.brandEntityId && ids.includes(org.brandEntityId)) throw new HttpError(400, "That’s your own brand; pick a different one.", { code: "COMPARE_SELF" });
    if (!org.brandEntityId && !input.seeds.length) throw new HttpError(400, "Keep at least one brand to read through: Qloo doesn’t know your brand yet, so the map reads its customers.", { code: "NEEDS_A_SEED" });
    const unknown = await ensureEntities([...input.rivals, ...input.seeds]);
    const missing = [...input.rivals, ...input.seeds].find((p) => unknown.includes(p.id));
    if (missing) throw new HttpError(400, `Search for ${missing.name} again and pick it from the list.`, { code: "PICK_FROM_LIST" });

    let intent: Record<string, unknown> = {};
    try {
      intent = org.metadata ? (JSON.parse(org.metadata) as Record<string, unknown>) : {};
    } catch {
      intent = {};
    }
    await prisma.organization.update({ where: { id: organization.id }, data: { metadata: JSON.stringify({ ...intent, rivals: input.rivals, seeds: input.seeds }) } });
    const map = await startBuild(organization.id, user.id, { rebuild: true });
    void audit({ organizationId: organization.id, actorId: user.id, action: "map.compare_set", targetType: "culture_map", targetId: map.id, data: { rivals: input.rivals.map((r) => r.name), seeds: input.seeds.map((s) => s.name) } }).catch(() => undefined);
    res.status(202).json({ map });
  } catch (error) {
    next(error);
  }
});

type Picked = { id?: string; name: string; kind: string; categories?: string[]; detail?: string };

/** Who the map compares with now, for the dialog. Any member or connected agency can read it. */
mapsRouter.get("/orgs/:id/compare", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await workspaceAccess(user.id, { id: String(req.params.id) });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id }, select: { name: true, metadata: true, brandEntityId: true, markets: true } });
    let intent: { rivals?: Picked[]; seeds?: Picked[]; category?: { name?: string } | null } = {};
    try {
      intent = org.metadata ? JSON.parse(org.metadata) : {};
    } catch {
      intent = {};
    }
    const keep = (xs?: Picked[]) => (xs ?? []).filter((p): p is Picked & { id: string } => Boolean(p.id) && p.kind !== "new");
    res.set("Cache-Control", "no-store").json({
      brand: org.name,
      known: Boolean(org.brandEntityId),
      market: org.markets[0] ?? "GB",
      category: intent.category?.name ?? null,
      rivals: keep(intent.rivals),
      seeds: keep(intent.seeds),
    });
  } catch (error) {
    next(error);
  }
});
