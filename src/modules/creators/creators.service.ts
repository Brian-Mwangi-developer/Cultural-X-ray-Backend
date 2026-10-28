import { z } from "zod";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { findTikTok, findYouTube, latestVideos, type Video } from "@/modules/creators/platforms";
import { generate } from "@/modules/gemini/gemini.client";
import { qloo } from "@/modules/lookup/qloo.client";
import { TTL } from "@/modules/lookup/cache";
import { BASE_ROWS, type Label } from "@/modules/maps/map.shape";
import { proofOf } from "@/modules/plays/plays";
import type { Attribution } from "@/modules/usage/ai-calls";

/**
 * Creators for a workspace: the people on its Culture Map (yours and shared), each with the channels
 * we could confirm and their latest public videos. Profiles are found once and kept for a month;
 * video lists are cached for six hours. Only people on the workspace's own map can be looked up.
 */

const RECHECK_DAYS = 30;
const VIDEOS_TTL = 6 * 3600;
const AT_ONCE = 3;

type External = Record<string, { id?: string } | { id?: string }[] | undefined>;
type QlooPerson = { entity_id: string; name: string; properties?: { external?: External; short_description?: string } };

const idsOf = (ext: External | undefined, key: string) => {
  const v = ext?.[key];
  return (Array.isArray(v) ? v : v ? [v] : []).map((x) => x.id).filter((x): x is string => Boolean(x));
};

/** Find (or refresh) the profiles of these people. Safe to call repeatedly: recent ones are skipped. */
export async function enrichPeople(entityIds: string[]) {
  const fresh = await prisma.creatorProfile.findMany({ where: { entityId: { in: entityIds }, checkedAt: { gt: new Date(Date.now() - RECHECK_DAYS * 86_400_000) } }, select: { entityId: true } });
  const todo = entityIds.filter((id) => !fresh.some((f) => f.entityId === id));
  if (!todo.length) return 0;
  const body = await qloo<{ results?: QlooPerson[] }>("/entities", { entity_ids: todo.join(",") }, TTL.record);
  const people = body.results ?? [];
  let found = 0;
  for (let i = 0; i < people.length; i += AT_ONCE) {
    await Promise.all(
      people.slice(i, i + AT_ONCE).map(async (p) => {
        const ext = p.properties?.external;
        const instagram = idsOf(ext, "instagram")[0] ?? null;
        const twitter = idsOf(ext, "twitter")[0] ?? null;
        const handles = [...idsOf(ext, "instagram"), ...idsOf(ext, "twitter")];
        const [yt, tt] = await Promise.all([findYouTube(p.name, handles), findTikTok(p.name, handles)]);
        if (yt || tt) found++;
        const data = {
          description: p.properties?.short_description ?? null,
          instagram,
          twitter,
          facebook: idsOf(ext, "facebook")[0] ?? null,
          youtubeChannel: yt?.channelId ?? null,
          youtubeHandle: yt?.handle ?? null,
          youtubeTitle: yt?.title ?? null,
          subscribers: yt?.subscribers ?? null,
          youtubeMatch: yt?.match ?? null,
          tiktokHandle: tt?.handle ?? null,
          tiktokName: tt?.name ?? null,
          tiktokMatch: tt?.match ?? null,
        };
        await prisma.creatorProfile.upsert({ where: { entityId: p.entity_id }, create: { entityId: p.entity_id, ...data }, update: data });
      }),
    );
  }
  logger.info({ asked: todo.length, found }, "creators: profiles checked");
  return found;
}

async function videosOf(channelId: string | null): Promise<Video[]> {
  if (!channelId) return [];
  const key = `yt:videos:${channelId}`;
  if (redis.status === "ready") {
    const hit = await redis.get(key).catch(() => null);
    if (hit) return JSON.parse(hit) as Video[];
  }
  const videos = await latestVideos(channelId);
  if (videos && redis.status === "ready") await redis.set(key, JSON.stringify(videos), "EX", VIDEOS_TTL).catch(() => undefined);
  return videos ?? [];
}

/** The people on the workspace's latest ready map, yours first, with where each ranks. */
async function peopleOnMap(workspaceId: string) {
  const map = await prisma.cultureMap.findFirst({
    where: { workspaceId, status: "READY" },
    orderBy: { createdAt: "desc" },
    select: { id: true, subjects: { select: { id: true, role: true, entity: { select: { name: true } } } } },
  });
  if (!map) return null;
  const you = (map.subjects.find((s) => s.role === "SELF") ?? map.subjects.find((s) => s.role === "SEED"))?.id ?? "";
  const names = new Map(map.subjects.map((s) => [s.id, s.entity.name]));
  const rivals = map.subjects.filter((s) => s.role === "RIVAL").map((s) => s.entity.name);
  const through = map.subjects.some((s) => s.role === "SELF") ? null : map.subjects.filter((s) => s.role === "SEED").map((s) => s.entity.name);
  const [items, ranks] = await Promise.all([
    prisma.territoryItem.findMany({
      where: { mapId: map.id, ...BASE_ROWS, category: "PERSON", label: { in: ["YOURS", "CONTESTED"] } },
      select: { label: true, leanSelf: true, rivalSubjectId: true, entity: { select: { id: true, name: true, imageUrl: true, properties: true, creator: true } } },
    }),
    prisma.association.findMany({ where: { mapId: map.id, ...BASE_ROWS, subjectId: you, category: "PERSON" }, select: { entityId: true, rank: true } }),
  ]);
  const rank = new Map(ranks.map((r) => [r.entityId, r.rank]));
  const people = items
    .map((i) => ({
      entityId: i.entity.id,
      name: i.entity.name,
      image: i.entity.imageUrl,
      detail: (i.entity.properties as { detail?: string } | null)?.detail ?? null,
      label: i.label as Label,
      rival: i.rivalSubjectId ? names.get(i.rivalSubjectId) ?? null : null,
      lean: i.leanSelf,
      rank: rank.get(i.entity.id) ?? 99,
      profile: i.entity.creator,
    }))
    .sort((a, b) => (a.label === b.label ? 0 : a.label === "YOURS" ? -1 : 1) || a.rank - b.rank);
  return { mapId: map.id, rivals, through, people };
}

type Person = NonNullable<Awaited<ReturnType<typeof peopleOnMap>>>["people"][number];

function card(p: Person, rivals: string[], videos: Video[], through: string[] | null) {
  const pr = p.profile;
  return {
    entityId: p.entityId,
    name: p.name,
    image: p.image,
    description: pr?.description ?? p.detail,
    label: p.label,
    rival: p.rival,
    proof: proofOf({ ref: "", entityId: p.entityId, name: p.name, kind: "PERSON", label: p.label, rival: p.rival, lean: p.lean, rank: p.rank, detail: null }, rivals, through),
    checked: Boolean(pr),
    youtube: pr?.youtubeChannel ? { channelId: pr.youtubeChannel, handle: pr.youtubeHandle, title: pr.youtubeTitle, subscribers: pr.subscribers, match: pr.youtubeMatch } : null,
    tiktok: pr?.tiktokHandle ? { handle: pr.tiktokHandle, name: pr.tiktokName, match: pr.tiktokMatch } : null,
    instagram: pr?.instagram ?? null,
    twitter: pr?.twitter ?? null,
    facebook: pr?.facebook ?? null,
    videos,
  };
}

/** Creator cards: the play's own people first when a play is given, then everyone else who's yours or shared. */
export async function creatorsFor(workspaceId: string, playId?: string) {
  const found = await peopleOnMap(workspaceId);
  if (!found) return { creators: [], checking: false };
  let order = found.people;
  if (playId) {
    const play = await prisma.play.findFirst({ where: { id: playId, map: { workspaceId } }, select: { items: true } });
    if (!play) throw new HttpError(404, "We couldn't find that play.");
    const first = ((play.items as { entityId: string }[] | null) ?? []).map((i) => i.entityId);
    order = [...order.filter((p) => first.includes(p.entityId)), ...order.filter((p) => !first.includes(p.entityId))];
  }
  const shown = order.slice(0, 12);
  const videos = await Promise.all(shown.map((p) => videosOf(p.profile?.youtubeChannel ?? null).then((v) => v.slice(0, 3))));
  return { creators: shown.map((p, i) => card(p, found.rivals, videos[i]!, found.through)), checking: shown.some((p) => !p.profile) };
}

export async function creatorDetail(workspaceId: string, entityId: string) {
  const found = await peopleOnMap(workspaceId);
  const p = found?.people.find((x) => x.entityId === entityId);
  if (!found || !p) throw new HttpError(404, "We couldn't find that creator on your map.");
  return { creator: card(p, found.rivals, await videosOf(p.profile?.youtubeChannel ?? null), found.through) };
}

/* ------------------------------------------------------------- outreach */

export const outreachSchema = z.object({ subject: z.string().trim().min(1).max(90), message: z.string().trim().min(1).max(1200) });

/** A first message to a creator, from the play and their latest video titles. Never about how anyone looks. */
export async function outreachDraft(workspaceId: string, entityId: string, playId: string | null, who: Attribution & { name?: string | null }) {
  const [{ creator }, org, play] = await Promise.all([
    creatorDetail(workspaceId, entityId),
    prisma.organization.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    playId ? prisma.play.findFirst({ where: { id: playId, map: { workspaceId } }, select: { title: true, rationale: true, brief: true } }) : null,
  ]);
  const brand = org?.name ?? "our brand";
  const titles = creator.videos.slice(0, 4).map((v) => `"${v.title}"`).join(", ");
  const prompt = [
    `Write a short, warm first message from ${who.name ?? "the team"} at ${brand} to ${creator.name}${creator.description ? ` (${creator.description})` : ""}, proposing a paid collaboration.`,
    play ? `The brand's thinking, for context only: ${play.rationale}` : "",
    `Write to ${creator.name} alone: never mention other creators, other people or other partners, and don't describe the brand's wider campaign.`,
    titles ? `Their latest videos: ${titles}. Mention one by name so it's clearly written for them.` : "",
    "Under 120 words. Plain, human, no hype, no emojis, no promises about fees or numbers. End by asking for a call. Sign off with the sender's name and brand.",
    "Never comment on anyone's age, body, face or looks.",
    "Answer only with JSON that matches the schema: subject and message.",
  ].filter(Boolean).join("\n");
  const practice = {
    subject: `A collaboration with ${brand}`,
    message: `Hi ${creator.name.split(" ")[0]}, I'm ${who.name ?? "with the team"} at ${brand}. Our customers already follow your work${creator.videos[0] ? `, and we loved "${creator.videos[0].title}"` : ""}. We'd like to talk about a short paid piece made your way. Would you be open to a call next week?\n\n${who.name ?? ""}${who.name ? ", " : ""}${brand}`,
  };
  try {
    const { name: _sender, ...attribution } = who;
    const { json } = await generate({ stage: "outreach", tier: "fast", parts: [prompt], schema: outreachSchema, practice, attribution });
    return json;
  } catch (error) {
    logger.warn({ entityId, ...errorDetails(error) }, "creators: outreach draft fell back to the template");
    return practice;
  }
}

