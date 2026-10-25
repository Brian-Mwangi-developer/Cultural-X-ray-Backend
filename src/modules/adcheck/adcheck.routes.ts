import { Readable } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import { Router } from "express";
import { z } from "zod";
import { HttpError } from "@/http/errors";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { membershipOf, requireRole } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import { adDetail, createAd, deleteAd, deleteVideo, listAds, PLACEMENTS, startAd, videoOf } from "@/modules/adcheck/adcheck.service";
import { stream } from "@/modules/adcheck/storage";

export const adCheckRouter = Router();

const WRITERS = ["owner", "admin", "strategist"] as const;

const createSchema = z.object({ fileName: z.string().trim().min(1).max(200), sizeBytes: z.number().int().positive(), contentType: z.string().min(1).max(100) });
const startSchema = z.object({ pathname: z.string().min(1).max(400).optional(), rivals: z.array(z.string().min(1).max(100)).max(5).default([]), placements: z.array(z.enum(PLACEMENTS)).max(PLACEMENTS.length).default([]) });

/** Create a check and get a one-path upload token; the browser then uploads straight to Blob. */
adCheckRouter.post("/orgs/:id/ads", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "check ads");
    const body = createSchema.parse(req.body ?? {});
    const created = await createAd(organization.id, user.id, { name: body.fileName, sizeBytes: body.sizeBytes, type: body.contentType });
    void audit({ organizationId: organization.id, actorId: user.id, action: "ad.create", targetType: "ad", targetId: created.adId }).catch(() => undefined);
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

/** The upload finished: save rivals and placements and start reading (202). Also retries a failed check. */
adCheckRouter.post("/orgs/:id/ads/:adId/start", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "check ads");
    const ad = await startAd(organization.id, String(req.params.adId), startSchema.parse(req.body ?? {}));
    res.status(202).json({ ad: { id: ad.id, status: ad.status, stage: ad.stage } });
  } catch (error) {
    next(error);
  }
});

adCheckRouter.get("/orgs/:id/ads", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await membershipOf(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ ads: await listAds(organization.id) });
  } catch (error) {
    next(error);
  }
});

adCheckRouter.get("/orgs/:id/ads/:adId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await membershipOf(user.id, { id: String(req.params.id) });
    res.set("Cache-Control", "no-store").json({ ad: await adDetail(organization.id, String(req.params.adId)) });
  } catch (error) {
    next(error);
  }
});

/** Plays the private video through the backend, with byte ranges so the player can seek. */
adCheckRouter.get("/orgs/:id/ads/:adId/video", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization } = await membershipOf(user.id, { id: String(req.params.id) });
    const pathname = await videoOf(organization.id, String(req.params.adId));
    const range = typeof req.headers.range === "string" && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
    const found = await stream(pathname, range);
    if (!found) throw new HttpError(410, "This video isn't available any more.", { code: "ADCHECK_GONE" });
    res.status(found.status).set(found.headers);
    const body = Readable.fromWeb(found.body as unknown as WebStream<Uint8Array>);
    req.on("close", () => body.destroy());
    body.on("error", (error) => (res.headersSent ? res.destroy(error) : next(error)));
    body.pipe(res);
  } catch (error) {
    next(error);
  }
});

/** Delete the video file only; the reading stays. */
adCheckRouter.delete("/orgs/:id/ads/:adId/video", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "delete ad videos");
    await deleteVideo(organization.id, String(req.params.adId));
    void audit({ organizationId: organization.id, actorId: user.id, action: "ad.video.delete", targetType: "ad", targetId: String(req.params.adId) }).catch(() => undefined);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** Delete the whole check: video, reading and re-cuts. */
adCheckRouter.delete("/orgs/:id/ads/:adId", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireRole(member.role, WRITERS, "delete ad checks");
    await deleteAd(organization.id, String(req.params.adId));
    void audit({ organizationId: organization.id, actorId: user.id, action: "ad.delete", targetType: "ad", targetId: String(req.params.adId) }).catch(() => undefined);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
