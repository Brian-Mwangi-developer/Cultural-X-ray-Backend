import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { publish } from "@/messaging/publisher";
import { EXCHANGES, QUEUES } from "@/messaging/topology";
import { type Handler, type HandlerMap, Outcome, PermanentError } from "@/messaging/types";
import { errorDetails, logger } from "@/observability/logger";
import { audioSchema, contextSchema, elementsFrom, FAILURE, practice, prompts, type Shot, type ShotDescription, shotSchema, shotsFrom, type Stage, textSchema } from "@/modules/adcheck/adcheck.shape";
import { prepare } from "@/modules/adcheck/adcheck.video";
import { download } from "@/modules/adcheck/storage";
import { GeminiUnavailable, generate, PolicyRefusal } from "@/modules/gemini/gemini.client";
import type { Attribution } from "@/modules/usage/ai-calls";

/**
 * Reading an ad in the worker: download → normalise → shots → context, text and sound (fast model)
 * → each shot (smart model, clipped) → save → READY. The web only polls progress.
 *
 * Resumable: each shot's description is saved as soon as it arrives and a retry skips described
 * shots, so a retry only pays again for the three cheap whole-ad passes.
 */

export const AD_CHECK = "ad.check";
const LOCK_SECONDS = 20 * 60;
/** Shots described at once: keeps a 40-shot ad to about a minute without tripping Vertex's rate limit. */
const IN_FLIGHT = 4;
/** Flash frames aren't worth a call; they stay in the shot list for the re-cut. */
const MIN_DESCRIBED_MS = 250;

export async function enqueueAdCheck(adId: string, organizationId: string) {
  return publish(EXCHANGES.jobs.name, AD_CHECK, { adId }, { organizationId });
}

const setStage = (adId: string, stage: Stage) => prisma.ad.update({ where: { id: adId }, data: { stage } });

async function fail(adId: string, reason: string) {
  await prisma.ad.update({ where: { id: adId }, data: { status: "FAILED", failureReason: reason, stage: null } }).catch(() => undefined);
}

/** Run `work` over items, at most `limit` at a time; the first failure is thrown after the rest settle. */
async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  const errors: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await work(item);
        } catch (error) {
          errors.push(error);
          if (error instanceof PolicyRefusal) queue.length = 0; // no point describing more
        }
      }
    }),
  );
  if (errors.length) throw errors.find((e) => e instanceof PolicyRefusal) ?? errors[0];
}

async function read(adId: string, attempt: number) {
  const ad = await prisma.ad.findUnique({
    where: { id: adId },
    select: { id: true, status: true, storageKey: true, workspaceId: true, uploadedById: true, videoDeletedAt: true, shots: { select: { index: true, startMs: true, endMs: true, description: true }, orderBy: { index: "asc" } } },
  });
  if (!ad || ad.status === "READY") return Outcome.Skipped;
  if (ad.videoDeletedAt) {
    await fail(adId, FAILURE.missing);
    return Outcome.Skipped;
  }
  const who: Attribution = { feature: "AD_CHECK", userId: ad.uploadedById, workspaceId: ad.workspaceId, adId };
  await prisma.ad.update({ where: { id: adId }, data: { status: "READING", stage: "preparing", failureReason: null } });

  const upload = await download(ad.storageKey);
  if (!upload) throw new PermanentError(FAILURE.missing);
  const prepared = await prepare(upload, config.adCheck.maxSeconds * 1000);
  if (prepared === "too_long") throw new PermanentError(FAILURE.tooLong(config.adCheck.maxSeconds));
  if (!prepared) throw new PermanentError(FAILURE.unreadable);
  const { video, durationMs } = prepared;
  await prisma.ad.update({ where: { id: adId }, data: { durationMs, width: prepared.width, height: prepared.height, stage: "finding shots" } });

  // Shots: reuse what an earlier attempt saved (with its descriptions), otherwise detect them.
  let shots: Shot[] = ad.shots.map(({ index, startMs, endMs }) => ({ index, startMs, endMs }));
  const described = new Map(ad.shots.filter((s) => s.description).map((s) => [s.index, shotSchema.parse(s.description)]));
  if (!shots.length) {
    shots = shotsFrom(prepared.cutsMs, durationMs);
    await prisma.adShot.createMany({ data: shots.map((s) => ({ adId, ...s })), skipDuplicates: true });
  }

  await setStage(adId, "watching");
  const whole = { video };
  const [context, text, audio] = await Promise.all([
    generate({ stage: "context", tier: "fast", parts: [whole, prompts.context()], schema: contextSchema, practice: practice.context, attribution: who }),
    generate({ stage: "text", tier: "fast", parts: [whole, prompts.text()], schema: textSchema, practice: practice.text, resolution: "HIGH", attribution: who }),
    prepared.hasAudio
      ? generate({ stage: "audio", tier: "fast", parts: [whole, prompts.audio()], schema: audioSchema, practice: practice.audio, attribution: who })
      : Promise.resolve({ json: { script: [], music: { present: false, genre: "", mood: "", tempo: "none" as const, vocals: "none" as const }, sounds: [] } }),
  ]);

  await setStage(adId, "describing shots");
  const todo = shots.filter((s) => !described.has(s.index) && s.endMs - s.startMs >= MIN_DESCRIBED_MS);
  await eachLimited(todo, IN_FLIGHT, async (shot) => {
    const { json } = await generate({
      stage: "shot",
      tier: "smart",
      parts: [{ video, clip: { startMs: shot.startMs, endMs: shot.endMs } }, prompts.shot(shot.index, shots.length, shot.startMs / 1000, shot.endMs / 1000, context.json)],
      schema: shotSchema,
      practice: practice.shot(shot.index),
      attribution: who,
    });
    described.set(shot.index, json);
    await prisma.adShot.update({ where: { adId_index: { adId, index: shot.index } }, data: { description: json } });
  });

  await setStage(adId, "saving");
  const rows = elementsFrom(durationMs, context.json, text.json, audio.json, shots.map((shot) => ({ shot, description: described.get(shot.index) ?? null as ShotDescription | null })));
  await prisma.$transaction([
    prisma.adElement.deleteMany({ where: { adId } }),
    prisma.adElement.createMany({ data: rows.map((r) => ({ adId, kind: r.kind, raw: r.raw, detail: r.detail as Prisma.InputJsonObject | undefined, startMs: r.startMs, endMs: r.endMs })) }),
    prisma.ad.update({ where: { id: adId }, data: { status: "READY", stage: "ready", readAt: new Date(), failureReason: null } }),
  ]);
  logger.info({ adId, shots: shots.length, described: described.size, elements: rows.length, attempt }, "ad read");
  return Outcome.Processed;
}

const jobSchema = z.object({ adId: z.string().min(1) });

const checkAd: Handler<typeof jobSchema> = {
  schema: jobSchema,
  async handle({ adId }, envelope) {
    const lock = `ad:check:${adId}`;
    if (redis.status === "ready" && (await redis.set(lock, envelope.id, "EX", LOCK_SECONDS, "NX")) !== "OK" && (await redis.get(lock)) !== envelope.id) {
      return Outcome.Skipped;
    }
    try {
      return await read(adId, envelope.attempt);
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        logger.warn({ adId, stage: error.stage, reason: error.reason }, "ad check: Gemini refused; for review");
        await fail(adId, FAILURE.refused);
      } else if (error instanceof GeminiUnavailable) {
        logger.error({ adId, ...errorDetails(error) }, "ad check: Gemini is not available");
        await fail(adId, FAILURE.off);
      } else if (error instanceof PermanentError) {
        await fail(adId, error.message);
      } else if (envelope.attempt >= QUEUES.adCheck.maxAttempts) {
        logger.warn({ adId, ...errorDetails(error) }, "ad check: out of attempts");
        await fail(adId, FAILURE.busy);
      }
      throw error;
    } finally {
      if (redis.status === "ready") await redis.del(lock).catch(() => undefined);
    }
  },
};

export const adCheckHandlers: HandlerMap = { [AD_CHECK]: checkAd as Handler };
