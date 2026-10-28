import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { redis } from "@/infra/redis";
import { enqueueVariant, variantKey } from "@/modules/maps/map.build";
import { AGES, CATEGORIES, categoryOf, isBase, type Kind, NICHE_POPULARITY_MAX, type Variant } from "@/modules/maps/map.shape";

/**
 * The Culture Map page: one category of the latest ready map, under the chosen filters, as three
 * lists (yours, shared, theirs). Each item carries where it ranks on each side and the Qloo calls
 * behind it, so the page can explain it in words and show its evidence. Filtered views are built
 * on first ask (about one call per brand compared) and kept.
 */

export type ViewQuery = { kind: Kind; variant: Variant };

const SIDE_TAKE = 20;

async function latestReady(workspaceId: string) {
  return prisma.cultureMap.findFirst({
    where: { workspaceId, status: "READY" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, market: true, builtAt: true, queryCount: true,
      subjects: { orderBy: { position: "asc" }, select: { id: true, role: true, entity: { select: { name: true } } } },
      readings: { select: { category: true, text: true } },
    },
  });
}

async function flag(key: string) {
  if (redis.status !== "ready") return null;
  return redis.get(key).catch(() => null);
}

export async function territoryView(workspaceId: string, { kind, variant }: ViewQuery) {
  const map = await latestReady(workspaceId);
  if (!map) return { map: null, view: null };
  const you = (map.subjects.find((s) => s.role === "SELF") ?? map.subjects.find((s) => s.role === "SEED"))?.id ?? "";
  const names = new Map(map.subjects.map((s) => [s.id, s.entity.name]));
  const where = { mapId: map.id, segment: variant.segment, tier: variant.tier };

  const [items, assocs, tally] = await Promise.all([
    prisma.territoryItem.findMany({
      where: { ...where, category: kind },
      select: { label: true, leanSelf: true, rivalSubjectId: true, entity: { select: { id: true, name: true, imageUrl: true, popularity: true, properties: true } } },
    }),
    prisma.association.findMany({
      where: { ...where, category: kind },
      select: { subjectId: true, entityId: true, rank: true, evidence: { select: { id: true, path: true, params: true, warnings: true } } },
    }),
    prisma.territoryItem.groupBy({ by: ["category", "label"], where, _count: { _all: true } }),
  ]);

  const rankOf = new Map(assocs.map((a) => [`${a.subjectId}:${a.entityId}`, a.rank]));
  const listSize = new Map<string, number>();
  for (const a of assocs) listSize.set(a.subjectId, Math.max(listSize.get(a.subjectId) ?? 0, a.rank + 1));
  const calls = new Map<string, { side: string; path: string; params: unknown; warnings: number }>();
  for (const a of assocs) calls.set(a.subjectId, { side: names.get(a.subjectId) ?? "A brand", path: a.evidence.path, params: a.evidence.params, warnings: Array.isArray(a.evidence.warnings) ? a.evidence.warnings.length : 0 });

  const ranked = items.map((i) => {
    const yourRank = rankOf.get(`${you}:${i.entity.id}`);
    const holder = i.rivalSubjectId;
    const theirRank = holder ? rankOf.get(`${holder}:${i.entity.id}`) : undefined;
    return {
      id: i.entity.id,
      name: i.entity.name,
      image: i.entity.imageUrl,
      detail: (i.entity.properties as { detail?: string } | null)?.detail ?? null,
      label: i.label,
      /** "niche" when Qloo's popularity is under the niche line; plain words only. */
      reach: i.entity.popularity != null && i.entity.popularity < NICHE_POPULARITY_MAX ? "niche" : "mainstream",
      lean: i.leanSelf,
      you: yourRank == null ? null : { rank: yourRank + 1, of: listSize.get(you) ?? SIDE_TAKE },
      them: holder ? { name: names.get(holder) ?? "A rival", rank: theirRank == null ? null : theirRank + 1, of: listSize.get(holder) ?? SIDE_TAKE } : null,
      calls: [calls.get(you), holder ? calls.get(holder) : undefined].filter(Boolean),
    };
  });
  const order = { YOURS: 0, CONTESTED: 1, THEIRS: 2 } as const;
  ranked.sort((a, b) => order[a.label] - order[b.label] || (a.you?.rank ?? a.them?.rank ?? 99) - (b.you?.rank ?? b.them?.rank ?? 99));

  const counts = Object.fromEntries(
    CATEGORIES.map((c) => {
      const rows = tally.filter((t) => t.category === c.kind);
      const n = (label: string) => rows.find((r) => r.label === label)?._count._all ?? 0;
      return [c.kind, rows.length ? { yours: n("YOURS"), contested: n("CONTESTED"), theirs: n("THEIRS") } : null];
    }),
  );

  let status: "ready" | "building" | "missing" = "ready";
  if (!ranked.length && !isBase(variant)) {
    if (await flag(`${variantKey(map.id, kind, variant)}:done`)) status = "ready";
    else status = (await flag(variantKey(map.id, kind, variant))) ? "building" : "missing";
  }

  // Probe of 28 October: with the niche cap, Qloo's podcast pool is so small that every brand gets
  // the same list (16 of 16 shared), while artists stay distinct (4 of 20 shared). A view where nearly
  // everything is shared can't tell customers apart, and the page says so instead of reading into it.
  const yours = ranked.filter((i) => i.label === "YOURS").length;
  const shared = ranked.filter((i) => i.label === "CONTESTED").length;
  const sameForEveryone = ranked.length > 0 && yours === 0 && shared / ranked.length >= 0.8;

  return {
    map: {
      id: map.id,
      market: map.market,
      builtAt: map.builtAt,
      queryCount: map.queryCount,
      you: names.get(you) ?? null,
      /** Qloo knows the brand itself; otherwise the map is read through `through` (see map.basis.ts). */
      known: map.subjects.some((s) => s.role === "SELF"),
      through: map.subjects.filter((s) => s.role === "SEED").map((s) => s.entity.name),
      rivals: map.subjects.filter((s) => s.role === "RIVAL").map((s) => s.entity.name),
    },
    view: {
      kind,
      segment: variant.segment,
      tier: variant.tier,
      status,
      /** What a filtered view costs: one call per brand compared, unless Qloo's answers are cached. */
      cost: map.subjects.filter((s) => s.role === "RIVAL").length + 1,
      sameForEveryone,
      reading: isBase(variant) ? map.readings.find((r) => r.category === kind)?.text ?? null : null,
      counts,
      items: ranked,
    },
  };
}

export function parseView(query: Record<string, unknown>): ViewQuery {
  const kind = categoryOf(String(query.category ?? "PODCAST"))?.kind;
  if (!kind) throw new HttpError(400, "That isn't a category on the map.", { code: "MAP_CATEGORY" });
  const segment = String(query.age ?? "");
  if (!AGES.some((a) => a.key === segment)) throw new HttpError(400, "That age band isn't one we offer.", { code: "MAP_AGE" });
  const tier = String(query.tier ?? "MAINSTREAM");
  if (tier !== "MAINSTREAM" && tier !== "NICHE") throw new HttpError(400, "Choose mainstream or niche.", { code: "MAP_TIER" });
  return { kind, variant: { segment, tier } as Variant };
}

/** Build a filtered view of one category (202). Already there, or already building: nothing to do. */
export async function requestView(workspaceId: string, userId: string, { kind, variant }: ViewQuery) {
  if (isBase(variant)) return { queued: false };
  const map = await latestReady(workspaceId);
  if (!map) throw new HttpError(409, "Build your Culture Map first.", { code: "MAP_NOT_READY" });
  const have = await prisma.territoryItem.count({ where: { mapId: map.id, category: kind, segment: variant.segment, tier: variant.tier } });
  if (have || (await flag(variantKey(map.id, kind, variant))) || (await flag(`${variantKey(map.id, kind, variant)}:done`))) return { queued: false };
  const published = await enqueueVariant(map.id, workspaceId, kind, variant, userId);
  if (!published.ok) throw new HttpError(503, "We couldn't start that view. Try again in a moment.", { code: "MAP_VIEW_QUEUE" });
  return { queued: true };
}

