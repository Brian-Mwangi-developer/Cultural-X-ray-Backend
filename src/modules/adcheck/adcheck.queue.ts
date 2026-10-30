import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { publish } from "@/messaging/publisher";
import { EXCHANGES, QUEUES } from "@/messaging/topology";
import { type Handler, type HandlerMap, Outcome, PermanentError } from "@/messaging/types";
import { errorDetails, logger } from "@/observability/logger";
import { type AdAudio, type AdContext, audioSchema, contextSchema, elementsFrom, FAILURE, practice, prompts, type Shot, type ShotDescription, shotSchema, shotsFrom, type Stage, textSchema } from "@/modules/adcheck/adcheck.shape";
import { comparisonFor, placeCues, placeReferences } from "@/modules/adcheck/adcheck.place";
import { cuesPrompt, cuesSchema, noMapVerdict, type PlacedCue, practiceCues, shotTerritory, uniqueCues, type Verdict, verdictFrom } from "@/modules/adcheck/adcheck.verdict";
import { prepare } from "@/modules/adcheck/adcheck.video";
import { checkFit } from "@/modules/adcheck/adcheck.fit";
import { fromShotNumbers, KINDS as RECUT_KINDS, practiceRecuts, readOfRecut, type RecutContext, recutPrompt, recutsSchema, type ShotContext, toEditList, toShotContexts } from "@/modules/adcheck/recut";
import { download } from "@/modules/adcheck/storage";
import { GeminiRequestError, GeminiUnavailable, generate, PolicyRefusal } from "@/modules/gemini/gemini.client";
import type { Attribution } from "@/modules/usage/ai-calls";
import { withMeter } from "@/modules/usage/meter";

/**
 * Reading an ad in the worker: download → normalise → shots → context, text and sound (fast model)
 * → each shot (smart model, clipped) → save → READY. The web only polls progress.
 *
 * Resumable: each shot's description is saved as soon as it arrives and a retry skips described
 * shots, so a retry only pays again for the three cheap whole-ad passes.
 */

export const AD_CHECK = "ad.check";
/** Writes (or rewrites) the suggested re-cuts of an ad that has been read. */
export const AD_RECUT = "ad.recut";
const LOCK_SECONDS = 20 * 60;
/** Shots described at once: keeps a 40-shot ad to about a minute without tripping Vertex's rate limit. */
const IN_FLIGHT = 4;
/** Flash frames aren't worth a call; they stay in the shot list for the re-cut. */
const MIN_DESCRIBED_MS = 250;

export async function enqueueAdCheck(adId: string, organizationId: string) {
  return publish(EXCHANGES.jobs.name, AD_CHECK, { adId }, { organizationId });
}

export async function enqueueRecut(adId: string, organizationId: string, userId: string) {
  return publish(EXCHANGES.jobs.name, AD_RECUT, { adId, userId }, { organizationId });
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
    select: { id: true, status: true, storageKey: true, workspaceId: true, uploadedById: true, videoDeletedAt: true, rivals: true, shots: { select: { index: true, startMs: true, endMs: true, description: true }, orderBy: { index: "asc" } } },
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
  ]);

  await setStage(adId, "placing on your map");
  const verdict = await withMeter({ workspaceId: ad.workspaceId, kind: "AD_CHECK", userId: who.userId ?? null }, () => placeOnMap(adId, ad.workspaceId, ad.rivals, context.json, audio.json, shots, described, who));
  // Before re-cutting: does the ad show what the business sells? Cutting can't add a missing product.
  await setStage(adId, "checking what it sells");
  const fit = await checkFit(adId, who).catch((error) => {
    logger.warn({ adId, ...errorDetails(error) }, "ad check: fit not checked");
    return null;
  });
  // The re-cuts are a bonus on top of the read: if writing them fails, the check is still ready.
  if (fit?.fits !== "no") {
    await setStage(adId, "writing re-cuts");
    await writeRecuts(adId, who).catch((error) => logger.warn({ adId, ...errorDetails(error) }, "ad check: re-cuts not written"));
  }
  await prisma.ad.update({ where: { id: adId }, data: { status: "READY", stage: "ready", readAt: new Date(), failureReason: null } });
  logger.info({ adId, shots: shots.length, described: described.size, elements: rows.length, lean: verdict.lean, attempt }, "ad read");
  return Outcome.Processed;
}

/**
 * Gemini turns the shots into cues (fast model, text only), Qloo places them and the ad's named
 * references, and the verdict is saved as a new check. Without a ready map the check says to build one.
 */
async function placeOnMap(adId: string, workspaceId: string, rivals: unknown, context: AdContext, audio: AdAudio, shots: Shot[], described: Map<number, ShotDescription>, who: Attribution) {
  const extra = (rivals as { entityIds?: string[] } | null)?.entityIds ?? [];
  const comparison = await comparisonFor(workspaceId, extra);
  if (!comparison) {
    const map = await prisma.cultureMap.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" }, select: { id: true } });
    const verdict = noMapVerdict();
    if (map) await saveCheck(adId, map.id, verdict);
    return verdict;
  }

  const seen = shots.flatMap((s) => (described.has(s.index) ? [{ index: s.index, description: described.get(s.index)! }] : []));
  const music = audio.music.present ? [audio.music.genre, audio.music.mood].filter(Boolean).join(", ") : "";
  const { json: cues } = await generate({
    stage: "cues",
    tier: "fast",
    parts: [cuesPrompt(context, seen, music)],
    schema: cuesSchema,
    practice: practiceCues(seen.map((s) => s.index)),
    attribution: who,
  });
  const shotCues = cues.shots.filter((s) => described.has(s.index));
  const placed = await placeCues(uniqueCues(cues), comparison.side, who);
  const references = await placeReferences([...context.references, ...context.brands.map((b) => ({ name: b.name, kind: "brand" }))], comparison);
  const verdict = verdictFrom(placed, shotCues, references);

  await prisma.$transaction([
    ...shots.map((shot) => {
      const mine = (shotCues.find((s) => s.index === shot.index)?.cues ?? []).map((c) => placed.get(c.toLowerCase().replace(/\s+/g, " ").trim())).filter((p): p is PlacedCue => Boolean(p));
      return prisma.adShot.update({
        where: { adId_index: { adId, index: shot.index } },
        data: { territory: shotTerritory(mine), evidence: { cues: mine.map((p) => ({ cue: p.cue, tag: p.tag, territory: p.judged?.territory ?? null, rival: p.judged?.rival ?? null })) } },
      });
    }),
  ]);
  await saveCheck(adId, comparison.mapId, verdict);
  return verdict;
}

/**
 * Three suggested re-cuts (Recommended, Shortest, Boldest) from everything the check knows, as edit
 * lists over the draft's own shots, each with where it would land. Replaces any earlier ones.
 */
export async function writeRecuts(adId: string, who: Attribution) {
  const ad = await prisma.ad.findUnique({
    where: { id: adId },
    select: {
      durationMs: true, placements: true, workspace: { select: { name: true } },
      shots: { orderBy: { index: "asc" }, select: { index: true, startMs: true, endMs: true, description: true, territory: true, evidence: true } },
      elements: { where: { kind: { in: ["ONSCREEN_TEXT", "SCRIPT", "SOUND"] } }, orderBy: { startMs: "asc" }, select: { kind: true, raw: true, detail: true, startMs: true, endMs: true } },
      checks: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, verdict: true, map: { select: { subjects: { where: { role: "RIVAL" }, select: { entity: { select: { name: true } } } } } } } },
    },
  });
  const check = ad?.checks[0];
  if (!ad || !check || !ad.durationMs || !ad.shots.length) return 0;
  const verdict = check.verdict as unknown as Verdict;
  if (verdict.headline.startsWith("Build your Culture Map")) return 0; // nothing to steer toward without a map
  // The wrong product can't be cut into the right one: no re-cuts, and none left from before.
  if (verdict.fit?.fits === "no") {
    await prisma.recut.deleteMany({ where: { adCheckId: check.id, kind: { in: [...RECUT_KINDS] } } });
    return 0;
  }

  const shots: ShotContext[] = toShotContexts(ad.shots, (d) => shotSchema.parse(d));
  const detail = (e: { detail: unknown }) => (e.detail ?? {}) as Record<string, unknown>;
  const music = ad.elements.find((e) => e.kind === "SOUND" && detail(e).music === true);
  const context: RecutContext = {
    brand: ad.workspace.name,
    rivals: check.map.subjects.map((x) => x.entity.name),
    durationMs: ad.durationMs,
    shots,
    text: ad.elements.filter((e) => e.kind === "ONSCREEN_TEXT").map((e) => ({ text: e.raw, startMs: e.startMs, endMs: e.endMs })),
    script: ad.elements.filter((e) => e.kind === "SCRIPT").map((e) => ({ words: e.raw, speaker: String(detail(e).speaker ?? "voice"), startMs: e.startMs, endMs: e.endMs })),
    music: music ? [music.raw, detail(music).mood].filter(Boolean).join(", ") : null,
    verdict,
    placements: ad.placements,
  };
  const { json } = await generate({ stage: "recuts", tier: "smart", parts: [recutPrompt(context)], schema: recutsSchema, practice: practiceRecuts(context), attribution: who });

  // One of each kind, in a fixed order; the first proposal of a kind wins.
  const byKind = new Map(fromShotNumbers(json).recuts.map((r) => [r.kind, r] as const));
  const rows = RECUT_KINDS.flatMap((kind) => {
    const proposal = byKind.get(kind);
    if (!proposal) return [];
    const edit = toEditList(proposal, shots, ad.workspace.name);
    return [{ adCheckId: check.id, kind, editList: edit as unknown as Prisma.InputJsonObject, verdict: readOfRecut(edit, shots) as unknown as Prisma.InputJsonObject, createdById: who.userId ?? null }];
  });
  await prisma.$transaction([prisma.recut.deleteMany({ where: { adCheckId: check.id, kind: { in: [...RECUT_KINDS] } } }), prisma.recut.createMany({ data: rows })]);
  return rows.length;
}

const recutJob = z.object({ adId: z.string().min(1), userId: z.string().nullish() });

const writeRecutsJob: Handler<typeof recutJob> = {
  schema: recutJob,
  async handle({ adId, userId }) {
    const ad = await prisma.ad.findUnique({ where: { id: adId }, select: { workspaceId: true, status: true } });
    if (!ad || ad.status !== "READY") return Outcome.Skipped;
    try {
      const who = { feature: "AD_CHECK" as const, userId: userId ?? null, workspaceId: ad.workspaceId, adId };
      // Ads checked before the fit check (or before it timed the product) get it now.
      const latest = await prisma.adCheck.findFirst({ where: { adId }, orderBy: { createdAt: "desc" }, select: { verdict: true } });
      if (latest && typeof (latest.verdict as { fit?: { productFirstShot?: number } } | null)?.fit?.productFirstShot !== "number") await checkFit(adId, who).catch((error) => logger.warn({ adId, ...errorDetails(error) }, "re-cuts: fit not checked"));
      const n = await writeRecuts(adId, who);
      logger.info({ adId, recuts: n }, "re-cuts written");
      return Outcome.Processed;
    } catch (error) {
      if (error instanceof PolicyRefusal || error instanceof GeminiRequestError || error instanceof GeminiUnavailable) {
        logger.warn({ adId, ...errorDetails(error) }, "re-cuts: not written");
        return Outcome.Skipped;
      }
      throw error;
    } finally {
      await prisma.ad.update({ where: { id: adId }, data: { stage: "ready" } }).catch(() => undefined);
    }
  },
};

/** One check per reading: a retry replaces it. */
async function saveCheck(adId: string, mapId: string, verdict: Verdict) {
  await prisma.$transaction([prisma.adCheck.deleteMany({ where: { adId } }), prisma.adCheck.create({ data: { adId, mapId, verdict: verdict as unknown as Prisma.InputJsonObject } })]);
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
      } else if (error instanceof GeminiRequestError) {
        // Our request was wrong, not the ad: people get a plain sentence, the logs get the detail.
        logger.error({ adId, stage: error.stage, detail: error.detail }, "ad check: Gemini rejected a request");
        await fail(adId, FAILURE.failed);
      } else if (error instanceof PermanentError) {
        // Our own reasons (too long, unreadable, upload missing) are written for people.
        await fail(adId, Object.values(FAILURE).includes(error.message as never) || error.message.startsWith("This ad is longer") ? error.message : FAILURE.failed);
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

export const adCheckHandlers: HandlerMap = { [AD_CHECK]: checkAd as Handler, [AD_RECUT]: writeRecutsJob as Handler };
