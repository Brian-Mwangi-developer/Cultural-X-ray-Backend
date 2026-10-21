import { prisma } from "@/infra/database";
import { HttpError } from "@/http/errors";
import { publish } from "@/messaging/publisher";
import { EXCHANGES } from "@/messaging/topology";
import { MAP_BUILD } from "@/modules/maps/map.build";
import { CATEGORIES, SEGMENTS } from "@/modules/maps/map.shape";

type Pick = { id?: string; name: string; kind: "brand" | "place" | "new" };
type Intent = { brand?: Pick; rivals?: Pick[]; seeds?: Pick[] };

const known = (p: Pick | undefined): p is Pick & { id: string } => Boolean(p && p.kind !== "new" && p.id);

/** Who a map reads, from the workspace's saved setup. Brands Qloo doesn't know are left out. */
function subjectsOf(metadata: string | null) {
  let intent: Intent = {};
  try {
    intent = metadata ? (JSON.parse(metadata) as Intent) : {};
  } catch {
    intent = {};
  }
  const rows: { entityId: string; role: "SELF" | "SEED" | "RIVAL" }[] = [];
  if (known(intent.brand)) rows.push({ entityId: intent.brand.id, role: "SELF" });
  for (const s of (intent.seeds ?? []).filter(known)) rows.push({ entityId: s.id, role: "SEED" });
  for (const r of (intent.rivals ?? []).filter(known)) rows.push({ entityId: r.id, role: "RIVAL" });
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.entityId) && seen.add(r.entityId)).map((r, position) => ({ ...r, position }));
}

const sameSubjects = (a: { entityId: string; role: string }[], b: { entityId: string; role: string }[]) =>
  a.length === b.length && a.every((s) => b.some((t) => t.entityId === s.entityId && t.role === s.role));

async function enqueue(mapId: string) {
  const published = await publish(EXCHANGES.jobs.name, MAP_BUILD, { mapId }, { priority: 5 });
  if (!published.ok) {
    await prisma.cultureMap.update({ where: { id: mapId }, data: { status: "FAILED" } });
    throw new HttpError(503, "We couldn't start building your map. Try again in a moment.", { code: "MAP_QUEUE" });
  }
}

/**
 * Start (or keep) the workspace's map. Returns straight away; the worker builds it.
 *  - A build already running for the same brands is returned as is.
 *  - A failed build for the same brands resumes: finished categories are kept.
 *  - A ready map for the same brands is kept unless `rebuild` is asked for.
 */
export async function startBuild(workspaceId: string, userId: string, { rebuild = false } = {}) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: workspaceId }, select: { metadata: true, markets: true, name: true } });
  const subjects = subjectsOf(org.metadata);
  if (!subjects.some((s) => s.role !== "RIVAL")) {
    throw new HttpError(400, "Pick your brand, or a brand your customers also buy, so we have a culture to read.", { code: "NEEDS_A_SEED" });
  }
  const market = org.markets[0] ?? "GB";
  const latest = await prisma.cultureMap.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, market: true, subjects: { select: { entityId: true, role: true } } },
  });
  if (latest && latest.market === market && sameSubjects(latest.subjects, subjects)) {
    if (latest.status === "QUEUED" || latest.status === "BUILDING") return { id: latest.id, status: latest.status };
    if (latest.status === "FAILED") {
      await prisma.cultureMap.update({ where: { id: latest.id }, data: { status: "QUEUED" } });
      await enqueue(latest.id);
      return { id: latest.id, status: "QUEUED" as const };
    }
    if (!rebuild) return { id: latest.id, status: latest.status };
  }
  const map = await prisma.cultureMap.create({
    data: { workspaceId, market, name: org.name, createdById: userId, categoriesTotal: CATEGORIES.length, subjects: { create: subjects } },
    select: { id: true, status: true },
  });
  await enqueue(map.id);
  return map;
}

type Item = { id: string; name: string; image: string | null; detail: string | null; label: "YOURS" | "CONTESTED" | "THEIRS"; lean: number | null; rival: string | null };

/** The workspace's latest map as the overview and build screens show it, or null. */
export async function latestMap(workspaceId: string, perCategory = 8) {
  const map = await prisma.cultureMap.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, market: true, categoriesDone: true, categoriesTotal: true, queryCount: true, thinData: true, builtAt: true, createdAt: true,
      subjects: { orderBy: { position: "asc" }, select: { id: true, role: true, entityId: true, entity: { select: { name: true, imageUrl: true } } } },
      readings: { select: { category: true, text: true } },
    },
  });
  if (!map) return null;
  const items = await prisma.territoryItem.findMany({
    where: { mapId: map.id },
    select: { category: true, label: true, leanSelf: true, rivalSubjectId: true, entity: { select: { id: true, name: true, imageUrl: true, properties: true } } },
  });
  const rank = new Map<string, number>();
  // Rank within the side that holds the item, so "yours" keeps Qloo's order.
  const assocs = await prisma.association.findMany({ where: { mapId: map.id }, select: { subjectId: true, entityId: true, category: true, rank: true } });
  for (const a of assocs) rank.set(`${a.subjectId}:${a.category}:${a.entityId}`, a.rank);
  const you = (map.subjects.find((s) => s.role === "SELF") ?? map.subjects.find((s) => s.role === "SEED"))?.id ?? "";
  const rivalName = new Map(map.subjects.map((s) => [s.id, s.entity.name]));
  const order = { YOURS: 0, CONTESTED: 0, THEIRS: 1 } as const;

  const categories = CATEGORIES.map((c) => {
    const reading = map.readings.find((r) => r.category === c.kind);
    const here = items.filter((i) => i.category === c.kind);
    const holder = (i: (typeof here)[number]) => (i.label === "THEIRS" ? i.rivalSubjectId ?? "" : you);
    const sorted = here
      .map((i) => ({ i, r: rank.get(`${holder(i)}:${c.kind}:${i.entity.id}`) ?? 99 }))
      .sort((a, b) => order[a.i.label] - order[b.i.label] || a.r - b.r)
      .map(({ i }): Item => ({
        id: i.entity.id,
        name: i.entity.name,
        image: i.entity.imageUrl,
        detail: ((i.entity.properties as { detail?: string } | null)?.detail as string | undefined) ?? null,
        label: i.label,
        lean: i.leanSelf,
        rival: i.rivalSubjectId ? rivalName.get(i.rivalSubjectId) ?? null : null,
      }));
    return {
      kind: c.kind,
      label: c.label,
      noun: c.noun,
      verb: c.verb,
      done: Boolean(reading),
      reading: reading?.text ?? null,
      counts: { yours: here.filter((i) => i.label === "YOURS").length, contested: here.filter((i) => i.label === "CONTESTED").length, theirs: here.filter((i) => i.label === "THEIRS").length },
      items: sorted.slice(0, perCategory),
    };
  });

  return {
    id: map.id,
    status: map.status,
    market: map.market,
    categoriesDone: map.categoriesDone,
    categoriesTotal: map.categoriesTotal,
    queryCount: map.queryCount,
    thinData: map.thinData,
    builtAt: map.builtAt,
    createdAt: map.createdAt,
    associations: items.length,
    subjects: map.subjects.map((s) => ({ id: s.id, role: s.role, entityId: s.entityId, name: s.entity.name, image: s.entity.imageUrl })),
    categories,
  };
}

type Cell = { value: number | null; masked: boolean; lowConfidence: boolean };

/**
 * The Audience & places page: who each side reaches (age and gender) and where its customers go.
 * "you" is your brand when Qloo knows it, otherwise the average of the brands your customers also buy.
 * Scores go to the web only to shade cells; the page puts them into words.
 */
export async function audienceOf(workspaceId: string) {
  const map = await prisma.cultureMap.findFirst({
    where: { workspaceId, status: "READY" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, market: true, builtAt: true, queryCount: true,
      subjects: { orderBy: { position: "asc" }, select: { id: true, role: true, entity: { select: { name: true } } } },
      audienceIndexes: { select: { subjectId: true, audience: true, value: true, placeholderMasked: true, lowConfidence: true } },
      geoSignals: { where: { kind: "DESTINATION" }, select: { subjectId: true, entityId: true, label: true, rank: true, payload: true } },
      territoryItems: { where: { category: "DESTINATION" }, select: { entityId: true, label: true, rivalSubjectId: true } },
    },
  });
  if (!map) return null;
  const self = map.subjects.find((s) => s.role === "SELF");
  const seeds = map.subjects.filter((s) => s.role === "SEED");
  const rivals = map.subjects.filter((s) => s.role === "RIVAL");
  const youSubject = (self ?? seeds[0])?.id ?? "";
  const yourSources = self ? [self.id] : seeds.map((s) => s.id);
  const name = new Map(map.subjects.map((s) => [s.id, s.entity.name]));

  const cellOf = (subjectId: string, audience: string): Cell => {
    const row = map.audienceIndexes.find((a) => a.subjectId === subjectId && a.audience === audience);
    return row ? { value: row.value, masked: row.placeholderMasked, lowConfidence: row.lowConfidence } : { value: null, masked: false, lowConfidence: false };
  };
  const yoursOf = (audience: string): Cell => {
    const cells = yourSources.map((id) => cellOf(id, audience));
    const values = cells.map((c) => c.value).filter((v): v is number => v != null);
    return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, masked: !values.length && cells.some((c) => c.masked), lowConfidence: cells.some((c) => c.lowConfidence) };
  };

  const label = new Map(map.territoryItems.map((t) => [t.entityId, t]));
  const places = new Map<string, { id: string; name: string; detail: string | null; lat: number | null; lon: number | null; label: "YOURS" | "CONTESTED" | "THEIRS"; rival: string | null; ranks: Record<string, number> }>();
  for (const g of map.geoSignals) {
    const payload = (g.payload ?? {}) as { lat?: number | null; lon?: number | null; detail?: string | null };
    const t = g.entityId ? label.get(g.entityId) : undefined;
    if (!g.entityId || !t) continue;
    const place = places.get(g.entityId) ?? { id: g.entityId, name: g.label, detail: payload.detail ?? null, lat: payload.lat ?? null, lon: payload.lon ?? null, label: t.label, rival: t.rivalSubjectId ? name.get(t.rivalSubjectId) ?? null : null, ranks: {} };
    place.ranks[g.subjectId === youSubject ? "you" : g.subjectId] = (g.rank ?? 0) + 1;
    places.set(g.entityId, place);
  }

  return {
    id: map.id,
    market: map.market,
    builtAt: map.builtAt,
    queryCount: map.queryCount,
    hasAudience: map.audienceIndexes.length > 0,
    sides: [
      { key: "you", name: self ? self.entity.name : seeds.map((s) => s.entity.name).join(" and "), readThrough: !self },
      ...rivals.map((r) => ({ key: r.id, name: r.entity.name, readThrough: false })),
    ],
    segments: SEGMENTS.map((s) => ({ key: s.key, label: s.label, cells: { you: yoursOf(s.key), ...Object.fromEntries(rivals.map((r) => [r.id, cellOf(r.id, s.key)])) } })),
    places: [...places.values()],
  };
}
