import { prisma } from "@/infra/database";
import { BASE_ROWS } from "@/modules/maps/map.shape";
import { TTL } from "@/modules/lookup/cache";
import { qloo, qlooEnabled } from "@/modules/lookup/qloo.client";
import { bestMatch, type QlooRecord } from "@/modules/lookup/qloo.shape";
import { type Attribution, recordCall } from "@/modules/usage/ai-calls";
import { clearest, CUE_TAG_TYPES, judge, type PlacedCue, type PlacedReference, type Side } from "@/modules/adcheck/adcheck.verdict";

/**
 * Qloo's side of the ad check: the map an ad is compared with, each cue's clearest tag and who it
 * belongs to, and named references looked up on the map. Answers are cached for a week, so checking
 * the same kind of ad again is nearly free. Each cue placed is recorded in ai_call (provider qloo, cost 0).
 */

const TAGS_PER_CUE = 4;
const IN_FLIGHT = 4;
const TIMEOUT = { timeoutMs: 60_000, tries: 3 };

type TagsBody = { results?: { tags?: { id: string; name: string; type?: string }[] } };
type InsightsBody = { results?: { entities?: { entity_id?: string; query?: { affinity?: number } }[] } };

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

export type Comparison = { mapId: string; side: Side; extraRivals: { id: string; name: string }[] };

/** The workspace's latest ready map, your side and the rivals (the map's, plus any picked for this ad). Null without a map. */
export async function comparisonFor(workspaceId: string, extraRivalIds: string[] = []): Promise<Comparison | null> {
  const map = await prisma.cultureMap.findFirst({
    where: { workspaceId, status: "READY" },
    orderBy: { builtAt: "desc" },
    select: { id: true, subjects: { select: { role: true, entityId: true, entity: { select: { name: true } } } } },
  });
  if (!map) return null;
  const you = map.subjects.filter((s) => s.role !== "RIVAL").map((s) => s.entityId);
  const rivals = map.subjects.filter((s) => s.role === "RIVAL").map((s) => ({ id: s.entityId, name: s.entity.name }));
  const known = new Set([...you, ...rivals.map((r) => r.id)]);
  const extraIds = extraRivalIds.filter((id) => !known.has(id));
  const extra = extraIds.length ? await prisma.qlooEntity.findMany({ where: { id: { in: extraIds } }, select: { id: true, name: true } }) : [];
  return { mapId: map.id, side: { you, rivals: [...rivals, ...extra] }, extraRivals: extra };
}

const brandIds = (side: Side) => [...side.you, ...side.rivals.map((r) => r.id)];

async function scoreTag(tagId: string, side: Side) {
  const ids = brandIds(side);
  const body = await limited(() =>
    qloo<InsightsBody>("/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.tags": tagId, "filter.results.entities": ids.join(","), take: Math.max(10, ids.length) }, TTL.insights, TIMEOUT),
  );
  return new Map((body.results?.entities ?? []).filter((e) => e.entity_id && typeof e.query?.affinity === "number").map((e) => [e.entity_id!, e.query!.affinity!]));
}

/** One cue: its tags of the types that carry brand signal, each scored; the clearest wins. */
async function placeCue(cue: string, side: Side): Promise<PlacedCue> {
  const tags = await limited(() =>
    qloo<TagsBody>("/v2/tags", { "filter.query": cue, "feature.semantic_search": "true", "filter.tag.types": CUE_TAG_TYPES.join(","), take: TAGS_PER_CUE }, TTL.tags, TIMEOUT),
  );
  const candidates = await Promise.all(
    (tags.results?.tags ?? []).map(async (t) => ({ tag: { id: t.id, name: t.name, type: (t.type ?? "").replace("urn:tag:", "") }, judged: judge(await scoreTag(t.id, side), side) })),
  );
  const best = clearest(candidates);
  return { cue, tag: best?.tag ?? candidates[0]?.tag ?? null, judged: best?.judged ?? null };
}

export async function placeCues(cues: string[], side: Side, who: Attribution): Promise<Map<string, PlacedCue>> {
  const placed = new Map<string, PlacedCue>();
  await Promise.all(
    cues.map(async (cue) => {
      const started = Date.now();
      placed.set(cue, await placeCue(cue, side));
      await recordCall({ ...who, provider: "qloo", model: "tags+insights", stage: "place", durationMs: Date.now() - started, outcome: "ok" });
    }),
  );
  // Keep the cue order stable for the verdict.
  return new Map(cues.filter((c) => placed.has(c)).map((c) => [c, placed.get(c)!]));
}

/** Qloo entity types to search for each kind of named reference. A bare search finds shops and albums first. */
const REFERENCE_TYPES: Record<string, string> = {
  brand: "urn:entity:brand",
  place: "urn:entity:destination,urn:entity:place",
  title: "urn:entity:movie,urn:entity:tv_show,urn:entity:book,urn:entity:podcast,urn:entity:videogame,urn:entity:artist",
  person: "urn:entity:person,urn:entity:artist",
};

/**
 * Names the ad itself mentions (titles, places, people, brands): searched by their kind, preferring a
 * result that is on the map, then looked up there. Events and other names aren't searched.
 */
export async function placeReferences(refs: { name: string; kind: string }[], comparison: Comparison): Promise<PlacedReference[]> {
  const rivalName = new Map(comparison.side.rivals.map((r) => [r.id, r.name]));
  const subjects = await prisma.mapSubject.findMany({ where: { mapId: comparison.mapId }, select: { id: true, entityId: true } });
  const rivalOfSubject = new Map(subjects.map((s) => [s.id, rivalName.get(s.entityId) ?? null]));
  const unique = [...new Map(refs.filter((r) => REFERENCE_TYPES[r.kind]).map((r) => [r.name.toLowerCase(), r])).values()].slice(0, 12);
  return Promise.all(
    unique.map(async ({ name, kind }): Promise<PlacedReference> => {
      const body = await limited(() => qloo<{ results?: QlooRecord[] }>("/search", { query: name, types: REFERENCE_TYPES[kind]!, take: 5 }, TTL.brandSearch, TIMEOUT));
      const results = body.results ?? [];
      const ids = results.map((r) => r.entity_id);
      const onMap = ids.length ? await prisma.territoryItem.findMany({ where: { mapId: comparison.mapId, ...BASE_ROWS, entityId: { in: ids } }, select: { entityId: true, label: true, rivalSubjectId: true } }) : [];
      const sides = new Set(brandIds(comparison.side));
      const match = results.find((r) => sides.has(r.entity_id) || onMap.some((i) => i.entityId === r.entity_id)) ?? bestMatch(results, name);
      if (!match) return { name, territory: null, rival: null };
      // The brands being compared are the map's subjects, not items on it.
      if (comparison.side.you.includes(match.entity_id)) return { name, territory: "YOURS", rival: null };
      const asRival = rivalName.get(match.entity_id);
      if (asRival) return { name, territory: "THEIRS", rival: asRival };
      const item = onMap.find((i) => i.entityId === match.entity_id);
      return { name, territory: item?.label ?? null, rival: item?.rivalSubjectId ? (rivalOfSubject.get(item.rivalSubjectId) ?? null) : null };
    }),
  );
}

export { qlooEnabled };
