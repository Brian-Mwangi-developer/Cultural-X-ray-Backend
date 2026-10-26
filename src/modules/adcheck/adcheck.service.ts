import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { errorDetails, logger } from "@/observability/logger";
import { enqueueAdCheck, enqueueRecut } from "@/modules/adcheck/adcheck.queue";
import { describe, remove, storageReady, uploadedPath, uploadToken, VIDEO_TYPES, videoPath } from "@/modules/adcheck/storage";

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
      shots: { orderBy: { index: "asc" }, select: { index: true, startMs: true, endMs: true, description: true, territory: true } },
      elements: { orderBy: [{ startMs: "asc" }, { kind: "asc" }], select: { id: true, kind: true, raw: true, detail: true, startMs: true, endMs: true, territory: true } },
      checks: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, mapId: true, verdict: true, createdAt: true, recuts: { where: { kind: { in: ["RECOMMENDED", "SHORTEST", "BOLDEST"] } }, orderBy: { kind: "asc" }, select: { id: true, kind: true, editList: true, verdict: true, createdAt: true } } },
      },
    },
  });
  if (!ad) throw new HttpError(404, "We couldn't find that ad check.");
  const { _count, videoDeletedAt, checks, ...rest } = ad;
  return { ...rest, check: checks[0] ?? null, shotCount: _count.shots, hasVideo: !videoDeletedAt, videoDeletedAt };
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
