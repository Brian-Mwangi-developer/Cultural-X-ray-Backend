import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { publish } from "@/messaging/publisher";
import { EXCHANGES } from "@/messaging/topology";
import { type Handler, type HandlerMap, Outcome } from "@/messaging/types";
import { errorDetails, logger } from "@/observability/logger";
import { enrichPeople } from "@/modules/creators/creators.service";
import { GeminiRequestError, GeminiUnavailable, generate, PolicyRefusal } from "@/modules/gemini/gemini.client";
import { type Kind, type Label, type Market } from "@/modules/maps/map.shape";
import { keepBacked, type PlayContext, type PlayItem, playsPrompt, playsSchema, practicePlays } from "@/modules/plays/plays";

/** Writes a workspace's plays from its latest ready map, then finds the channels of the people they name. */
export const PLAYS_WRITE = "plays.write";
const WRITING_SECONDS = 10 * 60;
/** Items per category given to Gemini: enough to choose from, small enough to stay cheap. */
const PER_CATEGORY = 8;

export const writingKey = (mapId: string) => `plays:writing:${mapId}`;

export async function enqueuePlays(mapId: string, organizationId: string, userId: string | null) {
  if (redis.status === "ready") await redis.set(writingKey(mapId), "1", "EX", WRITING_SECONDS).catch(() => undefined);
  return publish(EXCHANGES.jobs.name, PLAYS_WRITE, { mapId, userId }, { organizationId });
}

/** The map as the prompt needs it: per category, your side first in Qloo's order, then rivals' ground. */
export async function contextFor(mapId: string): Promise<PlayContext | null> {
  const map = await prisma.cultureMap.findUnique({
    where: { id: mapId },
    select: {
      status: true, market: true, workspace: { select: { name: true } },
      subjects: { select: { id: true, role: true, entity: { select: { name: true } } } },
      readings: { select: { category: true, text: true } },
    },
  });
  if (!map || map.status !== "READY") return null;
  const you = (map.subjects.find((s) => s.role === "SELF") ?? map.subjects.find((s) => s.role === "SEED"))?.id ?? "";
  const names = new Map(map.subjects.map((s) => [s.id, s.entity.name]));
  const [items, ranks] = await Promise.all([
    prisma.territoryItem.findMany({ where: { mapId }, select: { category: true, label: true, leanSelf: true, rivalSubjectId: true, entity: { select: { id: true, name: true, properties: true } } } }),
    prisma.association.findMany({ where: { mapId, subjectId: you }, select: { entityId: true, category: true, rank: true } }),
  ]);
  const rank = new Map(ranks.map((r) => [`${r.category}:${r.entityId}`, r.rank]));
  const order = { YOURS: 0, CONTESTED: 0, THEIRS: 1 } as const;
  const byKind = new Map<Kind, PlayItem[]>();
  let n = 0;
  for (const i of items
    .map((i) => ({ i, r: rank.get(`${i.category}:${i.entity.id}`) ?? 99 }))
    .sort((a, b) => order[a.i.label] - order[b.i.label] || a.r - b.r)) {
    const kind = i.i.category as Kind;
    const list = byKind.get(kind) ?? [];
    if (list.filter((x) => (x.label === "THEIRS") === (i.i.label === "THEIRS")).length >= (i.i.label === "THEIRS" ? 3 : PER_CATEGORY)) continue;
    list.push({
      ref: `i${++n}`,
      entityId: i.i.entity.id,
      name: i.i.entity.name,
      kind,
      label: i.i.label as Label,
      rival: i.i.rivalSubjectId ? names.get(i.i.rivalSubjectId) ?? null : null,
      lean: i.i.leanSelf,
      rank: i.r,
      detail: (i.i.entity.properties as { detail?: string } | null)?.detail ?? null,
    });
    byKind.set(kind, list);
  }
  return {
    brand: map.workspace.name,
    market: map.market as Market,
    rivals: map.subjects.filter((s) => s.role === "RIVAL").map((s) => s.entity.name),
    readings: map.readings.filter((r) => r.category).map((r) => ({ kind: r.category as Kind, text: r.text })),
    items: [...byKind.values()].flat(),
  };
}

export async function writePlays(mapId: string, userId: string | null) {
  const context = await contextFor(mapId);
  if (!context) return null;
  const map = await prisma.cultureMap.findUniqueOrThrow({ where: { id: mapId }, select: { workspaceId: true } });
  const { json } = await generate({
    stage: "plays",
    tier: "smart",
    parts: [playsPrompt(context)],
    schema: playsSchema,
    practice: practicePlays(context),
    attribution: { feature: "PLAYS", userId, workspaceId: map.workspaceId },
  });
  const rows = keepBacked(json, context);
  await prisma.$transaction([
    prisma.play.deleteMany({ where: { mapId } }),
    prisma.play.createMany({
      data: rows.map((r) => ({
        mapId, kind: r.kind, title: r.title, rationale: r.rationale, why: r.why, rank: r.rank, entityId: r.entityId,
        brief: r.brief as Prisma.InputJsonArray, items: r.items as unknown as Prisma.InputJsonArray,
      })),
    }),
  ]);
  return rows;
}

const jobSchema = z.object({ mapId: z.string().min(1), userId: z.string().nullish() });

const writePlaysJob: Handler<typeof jobSchema> = {
  schema: jobSchema,
  async handle({ mapId, userId }) {
    try {
      const rows = await writePlays(mapId, userId ?? null);
      if (!rows) return Outcome.Skipped;
      logger.info({ mapId, plays: rows.length }, "plays written");
      // The people the creator plays name get their channels looked up now, so the page has them ready.
      const people = [...new Set(rows.filter((r) => r.kind === "CREATOR").flatMap((r) => r.items.map((i) => i.entityId)))];
      const others = await prisma.territoryItem.findMany({ where: { mapId, category: "PERSON", label: { in: ["YOURS", "CONTESTED"] } }, select: { entityId: true }, take: 12 });
      await enrichPeople([...new Set([...people, ...others.map((o) => o.entityId)])].slice(0, 16)).catch((error) => logger.warn({ mapId, ...errorDetails(error) }, "plays: creator profiles not checked"));
      return Outcome.Processed;
    } catch (error) {
      if (error instanceof PolicyRefusal || error instanceof GeminiRequestError || error instanceof GeminiUnavailable) {
        logger.warn({ mapId, ...errorDetails(error) }, "plays: not written");
        return Outcome.Skipped;
      }
      throw error;
    } finally {
      if (redis.status === "ready") await redis.del(writingKey(mapId)).catch(() => undefined);
    }
  },
};

export const playHandlers: HandlerMap = { [PLAYS_WRITE]: writePlaysJob as Handler };
