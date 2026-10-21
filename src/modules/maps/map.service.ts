import { prisma } from "@/infra/database";
import { HttpError } from "@/http/errors";
import { publish } from "@/messaging/publisher";
import { EXCHANGES } from "@/messaging/topology";
import { MAP_BUILD } from "@/modules/maps/map.build";
import { CATEGORIES } from "@/modules/maps/map.shape";

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
