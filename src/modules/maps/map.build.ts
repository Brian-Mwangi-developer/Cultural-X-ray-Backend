import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { publish } from "@/messaging/publisher";
import { EXCHANGES, QUEUES } from "@/messaging/topology";
import { type Handler, type HandlerMap, Outcome, PermanentError } from "@/messaging/types";
import { enqueueEmail, isUndeliverable } from "@/modules/email/email.queue";
import { cacheKey, TTL } from "@/modules/lookup/cache";
import { qloo } from "@/modules/lookup/qloo.client";
import { AGES, audienceParams, BASE_ROWS, type Category, CATEGORIES, categoryOf, type Entity, entitiesOf, insightsParams, type Market, readingFor, scoresIn, SEGMENTS, splitTerritory, type Variant, variantParams, warningsOf } from "@/modules/maps/map.shape";
import { enqueuePlays } from "@/modules/plays/plays.queue";
import { withMeter } from "@/modules/usage/meter";

/**
 * Building a Culture Map in the worker. The web only reads progress, so leaving the page,
 * closing the tab or losing the connection never stops a build.
 *
 * Resumable: each category is saved in one transaction together with its reading, and a retry
 * skips the categories that already have one. Qloo answers are cached, so a retry costs almost
 * nothing for what was already fetched.
 */

export const MAP_BUILD = "map.build";
const INSIGHTS = "/v2/insights";
/** Insights calls take 1–40 s (map-build lab). Enough in flight to finish in about a minute without flooding Qloo. */
const IN_FLIGHT = 6;
const LOCK_SECONDS = 15 * 60;

/** A small semaphore, shared by every build in this worker. */
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

type Side = { subjectId: string; name: string; ids: string[] };
type Answer = { side: Side; entities: Entity[]; evidence: { id: string; params: Record<string, string | number>; key: string; ms: number; warnings: unknown[] | null } };

async function ask(category: Category, side: Side, market: Market, exclude: Set<string>, extra: Record<string, string | number> = {}): Promise<Answer> {
  const params = { ...insightsParams(category, side.ids, market), ...extra };
  const started = Date.now();
  const body = await limited(() => qloo(INSIGHTS, params, TTL.insights, { timeoutMs: 60_000, tries: 3 }));
  return {
    side,
    entities: entitiesOf(body, exclude),
    evidence: { id: randomUUID(), params, key: cacheKey(INSIGHTS, params), ms: Date.now() - started, warnings: warningsOf(body) },
  };
}

/** Some Qloo image links redirect to a 14px placeholder; only a direct 200 is real artwork. */
async function liveImage(url: string | null) {
  if (!url) return null;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4_000) });
    return res.status === 200 ? url : null;
  } catch {
    return null;
  }
}

/** Check artwork for the items the overview and build screen show first. The rest keep Qloo's link. */
async function checkImages(entities: Entity[], top = 8): Promise<string[]> {
  const dead: string[] = [];
  await Promise.all(
    entities.slice(0, top).map(async (e) => {
      const had = e.image;
      e.image = await liveImage(had);
      if (had && !e.image) dead.push(e.id);
    }),
  );
  return dead;
}

type Plan = { mapId: string; market: Market; you: Side; rivals: Side[]; exclude: Set<string>; subjects: { subjectId: string; entityId: string }[] };

/** One category: ask every side, split the lists, save everything (and the reading) at once. */
async function buildCategory(plan: Plan, category: Category) {
  const [mine, theirs] = await Promise.all([ask(category, plan.you, plan.market, plan.exclude), Promise.all(plan.rivals.map((side) => ask(category, side, plan.market, plan.exclude)))]);
  const dead = (await Promise.all([mine, ...theirs].map((a) => checkImages(a.entities)))).flat();
  const split = splitTerritory(mine.entities, new Map(theirs.map((a) => [a.side.subjectId, a.entities])));
  const names = new Map(plan.rivals.map((r) => [r.subjectId, r.name]));
  const text = readingFor(category, split, (id) => names.get(id) ?? "a rival") ?? `No ${category.noun} stand out for your customers yet.`;

  const answers = [mine, ...theirs];
  const entities = new Map(answers.flatMap((a) => a.entities.map((e) => [e.id, e] as const)));
  // An evidence row points at its cached answer only when that row is really there.
  const keys = new Set((await prisma.qlooCache.findMany({ where: { key: { in: answers.map((a) => a.evidence.key) } }, select: { key: true } })).map((r) => r.key));
  const evidenceOf = new Map(answers.map((a) => [a.side.subjectId, a.evidence.id]));

  await prisma.$transaction([
    prisma.qlooEntity.createMany({
      data: [...entities.values()].map((e) => ({ id: e.id, kind: category.kind, name: e.name, popularity: e.popularity, imageUrl: e.image, properties: e.detail ? { detail: e.detail } : undefined })),
      skipDuplicates: true,
    }),
    // Rows stored by an earlier build keep their old link; clear the ones we just found dead.
    prisma.qlooEntity.updateMany({ where: { id: { in: dead } }, data: { imageUrl: null } }),
    prisma.evidence.createMany({
      data: answers.map((a) => ({
        id: a.evidence.id,
        path: INSIGHTS,
        params: a.evidence.params,
        cacheKey: keys.has(a.evidence.key) ? a.evidence.key : null,
        status: a.evidence.warnings ? "WARNING" : "OK",
        warnings: (a.evidence.warnings as Prisma.InputJsonArray | null) ?? undefined,
        durationMs: a.evidence.ms,
      })),
    }),
    prisma.association.createMany({
      data: answers.flatMap((a) =>
        a.entities.map((e, rank) => ({ mapId: plan.mapId, subjectId: a.side.subjectId, entityId: e.id, category: category.kind, rank, affinity: e.affinity, evidenceId: a.evidence.id })),
      ),
      skipDuplicates: true,
    }),
    prisma.territoryItem.createMany({
      data: split.map((s) => ({
        mapId: plan.mapId,
        entityId: s.entity.id,
        category: category.kind,
        label: s.label,
        leanSelf: s.lean,
        rivalSubjectId: s.rival,
        evidenceId: evidenceOf.get(s.label === "THEIRS" ? s.rival! : plan.you.subjectId) ?? null,
      })),
      skipDuplicates: true,
    }),
    // Places also go on the globe, so each side's places keep their location and rank.
    ...(category.kind === "DESTINATION"
      ? [
          prisma.geoSignal.deleteMany({ where: { mapId: plan.mapId, kind: "DESTINATION" } }),
          prisma.geoSignal.createMany({
            data: answers.flatMap((a) =>
              a.entities.map((e, rank) => ({
                mapId: plan.mapId,
                subjectId: a.side.subjectId,
                kind: "DESTINATION" as const,
                entityId: e.id,
                label: e.name,
                value: e.affinity,
                rank,
                payload: { lat: e.location?.lat ?? null, lon: e.location?.lon ?? null, detail: e.detail },
                evidenceId: a.evidence.id,
              })),
            ),
          }),
        ]
      : []),
    prisma.mapReading.deleteMany({ where: { mapId: plan.mapId, category: category.kind } }),
    prisma.mapReading.create({ data: { mapId: plan.mapId, category: category.kind, text, evidence: { connect: answers.map((a) => ({ id: a.evidence.id })) } } }),
    prisma.cultureMap.update({ where: { id: plan.mapId }, data: { queryCount: { increment: answers.length } } }),
  ]);
  const done = await prisma.mapReading.count({ where: { mapId: plan.mapId } });
  await prisma.cultureMap.update({ where: { id: plan.mapId }, data: { categoriesDone: done } });
}

/** Who each brand reaches: one call per age band or gender scores every brand on the map. Saved in one go. */
async function buildAudience(plan: Plan) {
  const ids = [...new Set(plan.subjects.map((s) => s.entityId))];
  const calls = await Promise.all(
    SEGMENTS.map(async (segment) => {
      const params = audienceParams(segment, ids);
      const started = Date.now();
      const body = await limited(() => qloo(INSIGHTS, params, TTL.insights, { timeoutMs: 60_000, tries: 3 }));
      return { segment, scores: scoresIn(body, segment), evidence: { id: randomUUID(), params, key: cacheKey(INSIGHTS, params), ms: Date.now() - started, warnings: warningsOf(body) } };
    }),
  );
  const keys = new Set((await prisma.qlooCache.findMany({ where: { key: { in: calls.map((c) => c.evidence.key) } }, select: { key: true } })).map((r) => r.key));
  await prisma.$transaction([
    prisma.audienceIndex.deleteMany({ where: { mapId: plan.mapId } }),
    prisma.evidence.createMany({
      data: calls.map((c) => ({
        id: c.evidence.id,
        path: INSIGHTS,
        params: c.evidence.params,
        cacheKey: keys.has(c.evidence.key) ? c.evidence.key : null,
        status: c.evidence.warnings ? "WARNING" : "OK",
        warnings: (c.evidence.warnings as Prisma.InputJsonArray | null) ?? undefined,
        durationMs: c.evidence.ms,
      })),
    }),
    prisma.audienceIndex.createMany({
      data: calls.flatMap((c) =>
        plan.subjects.map((s) => {
          const score = c.scores.get(s.entityId) ?? { value: null, masked: false, lowConfidence: false };
          return { mapId: plan.mapId, subjectId: s.subjectId, audience: c.segment.key, value: score.value, placeholderMasked: score.masked, lowConfidence: score.lowConfidence, evidenceId: c.evidence.id };
        }),
      ),
    }),
    prisma.cultureMap.update({ where: { id: plan.mapId }, data: { queryCount: { increment: calls.length } } }),
  ]);
}

async function planFor(mapId: string) {
  const map = await prisma.cultureMap.findUnique({
    where: { id: mapId },
    select: {
      id: true, status: true, market: true, workspaceId: true, createdById: true,
      workspace: { select: { name: true, slug: true } },
      subjects: { orderBy: { position: "asc" }, select: { id: true, role: true, entityId: true, entity: { select: { name: true } } } },
      readings: { select: { category: true } },
      _count: { select: { audienceIndexes: true } },
    },
  });
  if (!map) return null;
  // Your side reads as your brand (when Qloo knows it) together with the brands your customers
  // also buy, exactly as onboarding's review promised. The seeds fill out a small brand's thin data.
  const youSubjects = map.subjects.filter((s) => s.role !== "RIVAL");
  const first = youSubjects.find((s) => s.role === "SELF") ?? youSubjects[0];
  if (!first) throw new PermanentError(`map ${mapId} has nothing to read through`);
  const plan: Plan = {
    mapId,
    market: map.market as Market,
    you: { subjectId: first.id, name: map.workspace.name, ids: youSubjects.map((s) => s.entityId) },
    rivals: map.subjects.filter((s) => s.role === "RIVAL").map((s) => ({ subjectId: s.id, name: s.entity.name, ids: [s.entityId] })),
    exclude: new Set(map.subjects.map((s) => s.entityId)),
    subjects: map.subjects.map((s) => ({ subjectId: s.id, entityId: s.entityId })),
  };
  return { map, plan, done: new Set(map.readings.map((r) => r.category as string)), audienceDone: map._count.audienceIndexes > 0 };
}

/** Ready: mark it once, then tell the person who started it. */
async function finish(mapId: string, workspaceId: string, workspace: { name: string; slug: string }, createdById: string | null) {
  const mine = await prisma.territoryItem.count({ where: { mapId, ...BASE_ROWS, label: { in: ["YOURS", "CONTESTED"] } } });
  const flipped = await prisma.cultureMap.updateMany({ where: { id: mapId, status: { not: "READY" } }, data: { status: "READY", builtAt: new Date(), thinData: mine < 20 } });
  if (!flipped.count) return;
  // Plays are written from the finished map; a failure to queue them never fails the build.
  await enqueuePlays(mapId, workspaceId, createdById).catch((error) => logger.warn({ mapId, ...errorDetails(error) }, "map: plays not queued"));
  if (!createdById) return;
  const user = await prisma.user.findUnique({ where: { id: createdById }, select: { email: true, name: true } });
  const podcast = await prisma.mapReading.findFirst({ where: { mapId, category: "PODCAST" }, select: { text: true } });
  const url = `${config.http.publicWebUrl}/${workspace.slug}`;
  await prisma.notification
    .create({ data: { userId: createdById, organizationId: workspaceId, kind: "MAP_READY", title: `${workspace.name}'s Culture Map is ready`, body: podcast?.text, targetType: "culture_map", targetId: mapId } })
    .catch((error) => logger.warn({ mapId, ...errorDetails(error) }, "map: could not store notification"));
  if (user && !isUndeliverable(user.email)) {
    await enqueueEmail({ template: "map-ready", to: user.email, name: user.name, workspaceName: workspace.name, reading: podcast?.text ?? "", url });
  }
}

const jobSchema = z.object({ mapId: z.string().min(1) });

const buildMap: Handler<typeof jobSchema> = {
  schema: jobSchema,
  async handle({ mapId }, envelope) {
    const lock = `map:build:${mapId}`;
    // A duplicate delivery of the same build waits its turn; the copy holding the lock finishes it.
    if (redis.status === "ready" && (await redis.set(lock, envelope.id, "EX", LOCK_SECONDS, "NX")) !== "OK" && (await redis.get(lock)) !== envelope.id) {
      return Outcome.Skipped;
    }
    try {
      const found = await planFor(mapId);
      if (!found || found.map.status === "READY") return Outcome.Skipped;
      const { map, plan, done, audienceDone } = found;
      await prisma.cultureMap.update({ where: { id: mapId }, data: { status: "BUILDING" } });

      const todo = CATEGORIES.filter((c) => !done.has(c.kind));
      const steps = [...todo.map((c) => ({ name: c.kind as string, run: () => buildCategory(plan, c) })), ...(audienceDone ? [] : [{ name: "AUDIENCE", run: () => buildAudience(plan) }])];
      const meter = { workspaceId: map.workspaceId, userId: map.createdById, kind: "MAP_BUILD" as const, mapId };
      const results = await withMeter(meter, () => Promise.allSettled(steps.map((step) => step.run())));
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ category: steps[i]?.name, error: r.reason as unknown }] : []));
      const first = failed[0];
      if (first) {
        logger.warn({ mapId, failed: failed.map((f) => f.category), attempt: envelope.attempt, ...errorDetails(first.error) }, "map build: categories failed");
        if (envelope.attempt >= QUEUES.mapBuild.maxAttempts) await prisma.cultureMap.update({ where: { id: mapId }, data: { status: "FAILED" } });
        throw first.error instanceof Error ? first.error : new Error(String(first.error));
      }
      await finish(mapId, map.workspaceId, map.workspace, map.createdById);
      logger.info({ mapId, steps: steps.length }, "map built");
      return Outcome.Processed;
    } catch (error) {
      if (error instanceof PermanentError) await prisma.cultureMap.update({ where: { id: mapId }, data: { status: "FAILED" } }).catch(() => undefined);
      throw error;
    } finally {
      if (redis.status === "ready") await redis.del(lock).catch(() => undefined);
    }
  },
};

/* ------------------------------------------------------------- filtered views */

export const MAP_VARIANT = "map.variant";
const VARIANT_SECONDS = 5 * 60;
const VARIANT_DONE_SECONDS = 30 * 86_400;
export const variantKey = (mapId: string, kind: string, v: Variant) => `map:variant:${mapId}:${kind}:${v.segment || "all"}:${v.tier}`;

/**
 * One category of a ready map, filtered (an age band, or niche only). The same comparison as the
 * build, with the filter's signal added, saved beside the base rows. No reading, globe or progress:
 * those belong to the base map. A filter with nothing in it is remembered, so it isn't asked again.
 */
async function buildVariant(plan: Plan, category: Category, v: Variant) {
  const extra = variantParams(v);
  const [mine, theirs] = await Promise.all([ask(category, plan.you, plan.market, plan.exclude, extra), Promise.all(plan.rivals.map((side) => ask(category, side, plan.market, plan.exclude, extra)))]);
  const split = splitTerritory(mine.entities, new Map(theirs.map((a) => [a.side.subjectId, a.entities])));
  const answers = [mine, ...theirs];
  const entities = new Map(answers.flatMap((a) => a.entities.map((e) => [e.id, e] as const)));
  const keys = new Set((await prisma.qlooCache.findMany({ where: { key: { in: answers.map((a) => a.evidence.key) } }, select: { key: true } })).map((r) => r.key));
  const evidenceOf = new Map(answers.map((a) => [a.side.subjectId, a.evidence.id]));
  await prisma.$transaction([
    prisma.qlooEntity.createMany({
      data: [...entities.values()].map((e) => ({ id: e.id, kind: category.kind, name: e.name, popularity: e.popularity, imageUrl: e.image, properties: e.detail ? { detail: e.detail } : undefined })),
      skipDuplicates: true,
    }),
    prisma.evidence.createMany({
      data: answers.map((a) => ({
        id: a.evidence.id, path: INSIGHTS, params: a.evidence.params, cacheKey: keys.has(a.evidence.key) ? a.evidence.key : null,
        status: a.evidence.warnings ? "WARNING" : "OK", warnings: (a.evidence.warnings as Prisma.InputJsonArray | null) ?? undefined, durationMs: a.evidence.ms,
      })),
    }),
    prisma.association.createMany({
      data: answers.flatMap((a) => a.entities.map((e, rank) => ({ mapId: plan.mapId, subjectId: a.side.subjectId, entityId: e.id, category: category.kind, segment: v.segment, tier: v.tier, rank, affinity: e.affinity, evidenceId: a.evidence.id }))),
      skipDuplicates: true,
    }),
    prisma.territoryItem.createMany({
      data: split.map((x) => ({
        mapId: plan.mapId, entityId: x.entity.id, category: category.kind, segment: v.segment, tier: v.tier, label: x.label, leanSelf: x.lean, rivalSubjectId: x.rival,
        evidenceId: evidenceOf.get(x.label === "THEIRS" ? x.rival! : plan.you.subjectId) ?? null,
      })),
      skipDuplicates: true,
    }),
  ]);
  return split.length;
}

const variantJob = z.object({ mapId: z.string().min(1), kind: z.string(), segment: z.enum(AGES.map((a) => a.key) as [string, ...string[]]), tier: z.enum(["MAINSTREAM", "NICHE"]), userId: z.string().nullish() });

const buildMapVariant: Handler<typeof variantJob> = {
  schema: variantJob,
  async handle({ mapId, kind, segment, tier, userId }) {
    const v = { segment, tier } as Variant;
    const category = categoryOf(kind);
    try {
      const found = await planFor(mapId);
      if (!found || found.map.status !== "READY" || !category) return Outcome.Skipped;
      const have = await prisma.territoryItem.count({ where: { mapId, category: category.kind, segment: v.segment, tier: v.tier } });
      if (have) return Outcome.Skipped;
      const meter = { workspaceId: found.map.workspaceId, userId: userId ?? null, kind: "MAP_BUILD" as const, mapId };
      const n = await withMeter(meter, () => buildVariant(found.plan, category, v));
      if (redis.status === "ready") await redis.set(`${variantKey(mapId, kind, v)}:done`, String(n), "EX", VARIANT_DONE_SECONDS).catch(() => undefined);
      logger.info({ mapId, kind, segment, tier, items: n }, "map view built");
      return Outcome.Processed;
    } finally {
      if (redis.status === "ready") await redis.del(variantKey(mapId, kind, v)).catch(() => undefined);
    }
  },
};

/** Queue a filtered view of one category; the page shows it as building until it lands. */
export async function enqueueVariant(mapId: string, workspaceId: string, kind: string, v: Variant, userId: string) {
  if (redis.status === "ready") await redis.set(variantKey(mapId, kind, v), "1", "EX", VARIANT_SECONDS).catch(() => undefined);
  return publish(EXCHANGES.jobs.name, MAP_VARIANT, { mapId, kind, segment: v.segment, tier: v.tier, userId }, { organizationId: workspaceId });
}

export const mapHandlers: HandlerMap = { [MAP_BUILD]: buildMap as Handler, [MAP_VARIANT]: buildMapVariant as Handler };
