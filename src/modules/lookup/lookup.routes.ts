import { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { HttpError } from "@/http/errors";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { membershipOf, requireManager } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import {
  brandSuggestions,
  categoryBrands,
  ensureEntities,
  placeSuggestions,
  searchBrands,
  searchCategories,
  searchLocalities,
  searchPlaces,
} from "@/modules/lookup/lookup.service";
import { siteReadStatus, startSiteRead } from "@/modules/lookup/site";

export const lookupRouter = Router();

/** Per person: search-as-you-type is chatty, but a person never needs more than this. Fails open without Redis. */
async function lookupLimit(req: Request, _res: Response, next: NextFunction) {
  try {
    if (redis.status !== "ready") return next();
    const key = `rl:lookup:${sessionOf(req).user.id}:${Math.floor(Date.now() / 60_000)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 70);
    if (count > 150) return next(new HttpError(429, "You're searching very fast. Wait a moment, then try again.", { code: "LOOKUP_RATE_LIMIT" }));
    next();
  } catch {
    next();
  }
}

const guard = [requireAuth, lookupLimit];
const market = z.enum(["GB", "US"]).default("GB");
const text = (min = 2) => z.string().trim().min(min, "Type a little more.").max(120, "That's too long to search.");

lookupRouter.get("/lookup/brands", ...guard, async (req, res, next) => {
  try {
    const q = text().parse(req.query.q);
    res.json({ results: await searchBrands(q) });
  } catch (error) {
    next(error);
  }
});

lookupRouter.get("/lookup/localities", ...guard, async (req, res, next) => {
  try {
    const q = text().parse(req.query.q);
    res.json({ results: await searchLocalities(q, market.parse(req.query.market)) });
  } catch (error) {
    next(error);
  }
});

lookupRouter.get("/lookup/places", ...guard, async (req, res, next) => {
  try {
    const q = text().parse(req.query.q);
    const lat = z.coerce.number().min(-90).max(90).parse(req.query.lat);
    const lon = z.coerce.number().min(-180).max(180).parse(req.query.lon);
    res.json({ results: await searchPlaces(q, { lat, lon }) });
  } catch (error) {
    next(error);
  }
});

lookupRouter.get("/lookup/entities/:id/suggestions", ...guard, async (req, res, next) => {
  try {
    const id = z.string().uuid("That brand isn't in our list.").parse(req.params.id);
    const kind = z.enum(["brand", "place"]).default("brand").parse(req.query.kind);
    const m = market.parse(req.query.market);
    const result = kind === "place" ? await placeSuggestions(id, m) : await brandSuggestions(id, m);
    if (!result) throw new HttpError(404, "We couldn't find suggestions for that one. Search for rivals instead.", { code: "SUGGESTIONS_NONE" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

lookupRouter.get("/lookup/categories", ...guard, async (req, res, next) => {
  try {
    res.json({ results: await searchCategories(text(3).parse(req.query.q)) });
  } catch (error) {
    next(error);
  }
});

lookupRouter.get("/lookup/category-brands", ...guard, async (req, res, next) => {
  try {
    const tag = z.string().regex(/^urn:tag:product_category:qloo:[a-z0-9_]+$/, "Choose a category from the list.").parse(req.query.tag);
    res.json(await categoryBrands(tag, market.parse(req.query.market)));
  } catch (error) {
    next(error);
  }
});

lookupRouter.post("/lookup/site", ...guard, async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().trim().min(4, "Paste your website's address.").max(300) }).parse(req.body);
    res.status(202).json(await startSiteRead(url));
  } catch (error) {
    next(error);
  }
});

lookupRouter.get("/lookup/site/:jobId", ...guard, async (req, res, next) => {
  try {
    res.json(await siteReadStatus(z.uuid().parse(req.params.jobId)));
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ saving onboarding's choices */

const pick = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["brand", "place", "new"]),
  categories: z.array(z.string().max(80)).max(5).optional(),
  detail: z.string().max(200).optional(),
});

const setupSchema = z.object({
  market: z.enum(["GB", "US"]),
  brand: pick.extend({
    website: z.string().max(300).optional(),
    sells: z.string().max(200).optional(),
    basedIn: z.string().max(120).optional(),
    location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
    locality: z.object({ id: z.string(), name: z.string().max(120), detail: z.string().max(200).optional() }).optional(),
  }),
  category: z.object({ id: z.string().max(120).nullable().optional(), name: z.string().max(80) }).nullable().optional(),
  rivals: z.array(pick).max(3).default([]),
  seeds: z.array(pick.extend({ kind: z.enum(["brand", "place"]), id: z.string().uuid() })).max(3).default([]),
  /** False while onboarding is still on step one. */
  complete: z.boolean().default(false),
});

/** Saves what onboarding found. Every Qloo id must be one we looked up, so a map never builds on an unknown entity. */
lookupRouter.post("/orgs/:id/brand-setup", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireManager(member.role, "set up this workspace");
    const input = setupSchema.parse(req.body);

    for (const p of [input.brand, ...input.rivals, ...input.seeds]) {
      if (p.kind !== "new" && !p.id) throw new HttpError(400, `Pick ${p.name} from the list, or add it as new.`, { code: "PICK_FROM_LIST" });
      if (p.kind === "new") delete p.id;
    }
    const picked = [input.brand, ...input.rivals, ...input.seeds].filter((p) => p.id && p.kind !== "new") as { id: string; name: string; kind: "brand" | "place" }[];
    const unknown = await ensureEntities(picked);
    const missing = picked.find((p) => unknown.includes(p.id));
    if (missing) throw new HttpError(400, `Search for ${missing.name} again and pick it from the list.`, { code: "PICK_FROM_LIST" });

    if (input.complete && !input.brand.id && !input.seeds.length) {
      throw new HttpError(400, "Pick at least one brand your customers also buy, so we have a culture to read.", { code: "NEEDS_A_SEED" });
    }

    const { complete, market: m, ...intent } = input;
    const metadata = { version: 2, ...intent, city: input.brand.locality?.name ?? input.brand.basedIn ?? undefined };
    // Independent writes in parallel: each round trip to Neon is slow from far away.
    await Promise.all([
      prisma.organization.update({
        where: { id: organization.id },
        data: { metadata: JSON.stringify(metadata), markets: [m], brandEntityId: input.brand.kind !== "new" ? input.brand.id ?? null : null },
      }),
      audit({ organizationId: organization.id, actorId: user.id, action: "workspace.brand_setup", targetType: "organization", targetId: organization.id, data: { complete, rivals: input.rivals.length, seeds: input.seeds.length } }),
    ]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
