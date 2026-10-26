import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { enqueuePlays, writingKey } from "@/modules/plays/plays.queue";

/** A workspace's plays, from its latest ready map. Owners and connected agencies read the same thing. */

async function latestReady(workspaceId: string) {
  return prisma.cultureMap.findFirst({ where: { workspaceId, status: "READY" }, orderBy: { createdAt: "desc" }, select: { id: true, queryCount: true } });
}

const writing = async (mapId: string) => redis.status === "ready" && (await redis.exists(writingKey(mapId)).catch(() => 0)) > 0;

const SELECT = { id: true, kind: true, title: true, rationale: true, why: true, brief: true, items: true, rank: true, createdAt: true } as const;

export async function listPlays(workspaceId: string) {
  const map = await latestReady(workspaceId);
  if (!map) return { mapReady: false, writing: false, writtenAt: null, queryCount: 0, plays: [] };
  const plays = await prisma.play.findMany({ where: { mapId: map.id, status: { not: "DISMISSED" } }, orderBy: { rank: "asc" }, select: SELECT });
  return { mapReady: true, writing: await writing(map.id), writtenAt: plays[0]?.createdAt ?? null, queryCount: map.queryCount, plays };
}

export async function playDetail(workspaceId: string, playId: string) {
  const play = await prisma.play.findFirst({ where: { id: playId, map: { workspaceId } }, select: SELECT });
  if (!play) throw new HttpError(404, "We couldn't find that play.");
  return { play };
}

/** Ask the worker to (re)write the plays from the latest ready map (202). */
export async function requestPlays(workspaceId: string, userId: string) {
  const map = await latestReady(workspaceId);
  if (!map) throw new HttpError(409, "Build your Culture Map first; plays are written from it.", { code: "PLAYS_NO_MAP" });
  const published = await enqueuePlays(map.id, workspaceId, userId);
  if (!published.ok) throw new HttpError(503, "We couldn't start writing plays. Try again in a moment.", { code: "PLAYS_QUEUE" });
}
