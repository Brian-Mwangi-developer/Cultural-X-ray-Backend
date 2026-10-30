import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { errorDetails, logger } from "@/observability/logger";
import { enqueueAdCheck, enqueueRecut } from "@/modules/adcheck/adcheck.queue";
import { craftFindings, type Placement } from "@/modules/adcheck/adcheck.craft";
import type { Fit } from "@/modules/adcheck/adcheck.fit";
import { describe, remove, storageReady, uploadedPath, uploadToken, VIDEO_TYPES, videoPath } from "@/modules/adcheck/storage";
import type { Prisma } from "@/generated/prisma/client";
import { comparisonFor, placeCues, qlooEnabled } from "@/modules/adcheck/adcheck.place";
import { shotSchema } from "@/modules/adcheck/adcheck.shape";
import type { PlacedCue } from "@/modules/adcheck/adcheck.verdict";
import { editFromTweak, readOfRecut, toShotContexts, type Tweak, wordsOf } from "@/modules/adcheck/recut";

/** Ad checks for one workspace: create and upload, start reading, read back, delete. */

export const PLACEMENTS = ["tiktok", "reels", "shorts", "youtube", "feed", "stories", "tv", "other"] as const;
/** Uploads that never finished are cleaned up after this long. */
const ABANDONED_HOURS = 24;

function needStorage() {
  if (!storageReady()) throw new HttpError(503, "Ad checks aren't set up yet.", { code: "ADCHECK_OFF" });
}

async function adOf(workspaceId: string, adId: string) {
  const ad = await prisma.ad.findFirst({ where: { id: adId, workspaceId } });
  if (!ad) throw new HttpError(404, "We couldn't find that ad check.");
  return ad;
}

/** A new check, ready for the browser to upload to: the path it may write and a token for it. */
export async function createAd(workspaceId: string, userId: string, file: { name: string; sizeBytes: number; type: string }) {
  needStorage();
  if (!(VIDEO_TYPES as readonly string[]).includes(file.type)) throw new HttpError(400, "Upload an MP4, MOV or WebM video.", { code: "ADCHECK_TYPE" });
  if (file.sizeBytes > config.adCheck.maxBytes) throw new HttpError(400, `Videos can be up to ${Math.round(config.adCheck.maxBytes / 1_000_000)} MB.`, { code: "ADCHECK_SIZE" });

  const title = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 120) || "Untitled ad";
  const ad = await prisma.ad.create({ data: { workspaceId, uploadedById: userId, title, fileName: file.name.slice(0, 200), sizeBytes: file.sizeBytes, storageKey: "", status: "UPLOADING" } });
  const pathname = videoPath(workspaceId, ad.id, file.name);
  await prisma.ad.update({ where: { id: ad.id }, data: { storageKey: pathname } });
  return { adId: ad.id, pathname, clientToken: await uploadToken(pathname, config.adCheck.maxBytes), access: config.blob.access, maxSeconds: config.adCheck.maxSeconds };
}

/** After the upload: check the file arrived, save the choices, and queue the reading. Also retries a failed check. */
export async function startAd(workspaceId: string, adId: string, input: { rivals: string[]; placements: string[]; pathname?: string }) {
  needStorage();
  const ad = await adOf(workspaceId, adId);
  if (ad.videoDeletedAt) throw new HttpError(410, "This video was deleted. Upload it again to check it.", { code: "ADCHECK_GONE" });
  if (ad.status === "QUEUED" || ad.status === "READING") return ad;
  if (ad.status === "READY") throw new HttpError(409, "This ad has already been checked.", { code: "ADCHECK_DONE" });

  const pathname = uploadedPath(ad.storageKey, input.pathname);
  if (!pathname) throw new HttpError(400, "That upload doesn't belong to this ad check.", { code: "ADCHECK_PATH" });
  const file = await describe(pathname);
  if (!file) throw new HttpError(409, "The upload didn't finish. Try again.", { code: "ADCHECK_NOT_UPLOADED" });
  const started = await prisma.ad.update({
    where: { id: adId },
    data: { status: "QUEUED", stage: "queued", failureReason: null, storageKey: pathname, sizeBytes: file.size, rivals: { entityIds: input.rivals }, placements: input.placements },
  });
  const published = await enqueueAdCheck(adId, workspaceId);
  if (!published.ok) {
    await prisma.ad.update({ where: { id: adId }, data: { status: "FAILED", stage: null, failureReason: "We couldn't start reading this ad. Try again." } });
    throw new HttpError(503, "We couldn't start reading this ad. Try again in a moment.", { code: "ADCHECK_QUEUE" });
  }
  return started;
}

const summary = {
  id: true, title: true, fileName: true, status: true, stage: true, failureReason: true, durationMs: true, width: true, height: true, sizeBytes: true,
  placements: true, createdAt: true, readAt: true, videoDeletedAt: true, uploadedBy: { select: { id: true, name: true } }, _count: { select: { shots: true } },
} as const;

export async function listAds(workspaceId: string) {
  const ads = await prisma.ad.findMany({
    where: { workspaceId, status: { not: "UPLOADING" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { ...summary, checks: { orderBy: { createdAt: "desc" }, take: 1, select: { verdict: true } } },
  });
  return ads.map(({ _count, videoDeletedAt, checks, ...ad }) => {
    const verdict = checks[0]?.verdict as { lean?: string; rival?: string | null; headline?: string } | undefined;
    return { ...ad, shotCount: _count.shots, hasVideo: !videoDeletedAt, videoDeletedAt, lean: verdict?.lean ?? null, rival: verdict?.rival ?? null, headline: verdict?.headline ?? null };
  });
}

export async function adDetail(workspaceId: string, adId: string) {
  const ad = await prisma.ad.findFirst({
    where: { id: adId, workspaceId },
    select: {
      ...summary,
      rivals: true,
      workspace: { select: { name: true } },
      shots: { orderBy: { index: "asc" }, select: { index: true, startMs: true, endMs: true, description: true, territory: true } },
      elements: { orderBy: [{ startMs: "asc" }, { kind: "asc" }], select: { id: true, kind: true, raw: true, detail: true, startMs: true, endMs: true, territory: true } },
      checks: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          mapId: true,
          verdict: true,
          createdAt: true,
          recuts: { where: { kind: { in: ["RECOMMENDED", "SHORTEST", "BOLDEST"] } }, orderBy: { kind: "asc" }, select: { id: true, kind: true, editList: true, verdict: true, createdAt: true } },
        },
      },
    },
  });
  if (!ad) throw new HttpError(404, "We couldn't find that ad check.");
  const { _count, videoDeletedAt, checks, workspace, ...rest } = ad;
  const check = checks[0] ?? null;
  return { ...rest, check, craft: check ? craftOf(ad, workspace.name, check.verdict as { fit?: Fit } | null) : [], shotCount: _count.shots, hasVideo: !videoDeletedAt, videoDeletedAt };
}

/** What would hold the ad back where it runs (adcheck.craft.ts), from what the check measured. */
function craftOf(
  ad: { width: number | null; height: number | null; placements: string[]; durationMs: number | null; shots: { index: number; startMs: number }[]; elements: { kind: string; raw: string; detail: unknown; startMs: number }[] },
  brand: string,
  verdict: { fit?: Fit } | null,
) {
  const first = verdict?.fit?.productFirstShot;
  return craftFindings({
    width: ad.width,
    height: ad.height,
    durationMs: ad.durationMs ?? 0,
    placements: ad.placements as Placement[],
    brand,
    // Fit checks from before productFirstShot existed can't say when the product appears.
    productKnown: typeof first === "number",
    productAtMs: first ? ad.shots.find((s) => s.index === first - 1)?.startMs ?? null : null,
    onScreen: ad.elements.filter((e) => e.kind === "ONSCREEN_TEXT").map((e) => ({ text: e.raw, kind: String((e.detail as { kind?: string } | null)?.kind ?? "other"), startMs: e.startMs })),
    spokenLines: ad.elements.filter((e) => e.kind === "SCRIPT").length,
    hasSound: ad.elements.some((e) => e.kind === "SCRIPT" || e.kind === "SOUND"),
  });
}

/** Ask the worker to (re)write the suggested re-cuts of a read ad. The ad's stage says so until they land. */
export async function requestRecuts(workspaceId: string, adId: string, userId: string) {
  const ad = await adOf(workspaceId, adId);
  if (ad.status !== "READY") throw new HttpError(409, "The ad has to be read before it can be re-cut.", { code: "ADCHECK_NOT_READY" });
  const published = await enqueueRecut(adId, workspaceId, userId);
  if (!published.ok) throw new HttpError(503, "We couldn't start the re-cuts. Try again in a moment.", { code: "ADCHECK_QUEUE" });
  await prisma.ad.update({ where: { id: adId }, data: { stage: "writing re-cuts" } });
}

/** Where the video is, for streaming. 410 once deleted. */
export async function videoOf(workspaceId: string, adId: string) {
  needStorage();
  const ad = await adOf(workspaceId, adId);
  if (ad.videoDeletedAt || !ad.storageKey) throw new HttpError(410, "This video was deleted.", { code: "ADCHECK_GONE" });
  return ad.storageKey;
}

/** Delete the file only: the reading stays, without playback. */
export async function deleteVideo(workspaceId: string, adId: string) {
  needStorage();
  const ad = await adOf(workspaceId, adId);
  if (ad.videoDeletedAt) return;
  await removeOrExplain(ad.storageKey);
  await prisma.ad.update({ where: { id: adId }, data: { videoDeletedAt: new Date() } });
}

/** Delete everything: the file, the reading, the checks and re-cuts. */
export async function deleteAd(workspaceId: string, adId: string) {
  const ad = await adOf(workspaceId, adId);
  if (!ad.videoDeletedAt && ad.storageKey) {
    needStorage();
    await removeOrExplain(ad.storageKey);
  }
  await prisma.ad.delete({ where: { id: adId } });
}

async function removeOrExplain(pathname: string) {
  try {
    await remove(pathname);
  } catch (error) {
    logger.warn({ pathname, ...errorDetails(error) }, "adcheck: could not delete a video");
    throw new HttpError(503, "We couldn't delete the video just now. Try again in a moment.", { code: "ADCHECK_DELETE" });
  }
}

/**
 * Housekeeping, run by the worker: videos older than ADCHECK_KEEP_DAYS are deleted (the reading
 * stays), and uploads abandoned for a day are removed with their row.
 */
export async function sweepVideos(now = new Date()) {
  if (!storageReady()) return { expired: 0, abandoned: 0 };
  const keepBefore = new Date(now.getTime() - config.adCheck.keepDays * 86_400_000);
  const abandonedBefore = new Date(now.getTime() - ABANDONED_HOURS * 3_600_000);
  const expired = await prisma.ad.findMany({ where: { videoDeletedAt: null, createdAt: { lt: keepBefore }, status: { notIn: ["UPLOADING", "QUEUED", "READING"] } }, select: { id: true, storageKey: true }, take: 200 });
  const abandoned = await prisma.ad.findMany({ where: { status: "UPLOADING", createdAt: { lt: abandonedBefore } }, select: { id: true, storageKey: true }, take: 200 });
  let done = { expired: 0, abandoned: 0 };
  for (const ad of expired) {
    try {
      if (ad.storageKey) await remove(ad.storageKey);
      await prisma.ad.update({ where: { id: ad.id }, data: { videoDeletedAt: now } });
      done = { ...done, expired: done.expired + 1 };
    } catch (error) {
      logger.warn({ adId: ad.id, ...errorDetails(error) }, "adcheck sweep: could not delete an old video");
    }
  }
  for (const ad of abandoned) {
    try {
      if (ad.storageKey) await remove(ad.storageKey);
      await prisma.ad.delete({ where: { id: ad.id } });
      done = { ...done, abandoned: done.abandoned + 1 };
    } catch (error) {
      logger.warn({ adId: ad.id, ...errorDetails(error) }, "adcheck sweep: could not remove an abandoned upload");
    }
  }
  if (done.expired || done.abandoned) logger.info(done, "adcheck sweep");
  return done;
}

let sweepTimer: NodeJS.Timeout | null = null;
export function startVideoSweep(everyMs = 3_600_000) {
  if (sweepTimer) return;
  const tick = () => void sweepVideos().catch((error) => logger.warn(errorDetails(error), "adcheck sweep failed"));
  sweepTimer = setInterval(tick, everyMs);
  sweepTimer.unref();
  tick();
}
export function stopVideoSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** The versions someone tweaked and checked again (R6–R7), newest first. */
export async function versionsOf(workspaceId: string, adId: string) {
  return prisma.recut.findMany({
    where: { kind: "CUSTOM", adCheck: { ad: { id: adId, workspaceId } } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, kind: true, editList: true, verdict: true, parentId: true, createdAt: true, createdBy: { select: { name: true } } },
  });
}

/**
 * Save a tweaked version and check it again (R6 → R7). Reordering, trimming and dropping need no model:
 * each kept shot's cues were placed when the draft was read. Only new words (captions, the end card)
 * are placed on the map, with a few Qloo look-ups. Returns the version with its read.
 */
export async function saveVersion(workspaceId: string, adId: string, userId: string, tweak: Tweak & { from?: string | null }) {
  const ad = await prisma.ad.findFirst({
    where: { id: adId, workspaceId },
    select: {
      status: true,
      rivals: true,
      workspace: { select: { name: true } },
      shots: { orderBy: { index: "asc" }, select: { index: true, startMs: true, endMs: true, description: true, territory: true, evidence: true } },
      checks: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
    },
  });
  if (!ad) throw new HttpError(404, "We couldn't find that ad check.");
  const check = ad.checks[0];
  if (ad.status !== "READY" || !check || !ad.shots.length) throw new HttpError(409, "The ad has to be read before it can be tweaked.", { code: "ADCHECK_NOT_READY" });

  const shots = toShotContexts(ad.shots, (d) => shotSchema.safeParse(d).data ?? null);
  const edit = editFromTweak(tweak, shots, ad.workspace.name);
  if ("problem" in edit) throw new HttpError(400, edit.problem, { code: "ADCHECK_BAD_VERSION" });

  let words = new Map<string, PlacedCue>();
  const said = wordsOf(edit);
  if (said.length && qlooEnabled()) {
    const extra = ((ad.rivals as { entityIds?: string[] } | null)?.entityIds ?? []).filter((x) => typeof x === "string");
    const comparison = await comparisonFor(workspaceId, extra).catch(() => null);
    if (comparison) {
      words = await placeCues(said, comparison.side, { feature: "AD_CHECK", userId, workspaceId, adId }).catch((error) => {
        logger.warn({ adId, ...errorDetails(error) }, "ad check: new words not placed");
        return new Map<string, PlacedCue>();
      });
    }
  }
  const verdict = readOfRecut(edit, shots, words);
  const parent = tweak.from ? await prisma.recut.findFirst({ where: { id: tweak.from, adCheckId: check.id }, select: { id: true } }) : null;
  return prisma.recut.create({
    data: { adCheckId: check.id, kind: "CUSTOM", editList: edit as unknown as Prisma.InputJsonObject, verdict: verdict as unknown as Prisma.InputJsonObject, parentId: parent?.id ?? null, createdById: userId },
    select: { id: true, kind: true, editList: true, verdict: true, parentId: true, createdAt: true },
  });
}
