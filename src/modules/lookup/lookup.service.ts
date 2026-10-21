import { prisma } from "@/infra/database";
import { errorDetails, logger } from "@/observability/logger";
import { TTL } from "@/modules/lookup/cache";
import { qloo } from "@/modules/lookup/qloo.client";
import {
  bestMatch,
  brandCard,
  type Card,
  categoriesOf,
  countryName,
  type Market,
  placeCard,
  placeGenres,
  primaryGenreId,
  type QlooRecord,
  sellsIn,
  sharesCategory,
  slug,
  tagIdsOf,
  tagsOf,
} from "@/modules/lookup/qloo.shape";

/** A suggested brand or place, already checked against Qloo. */
export type Suggestion = { name: string; status: "ok" | "other_market" | "not_found"; card?: Card };

const BRAND = "urn:entity:brand";
const PLACE = "urn:entity:place";
const MARKET_TAG: Record<Market, string> = { GB: "urn:tag:key_market:qloo:united_kingdom", US: "urn:tag:key_market:qloo:united_states" };

type SearchBody = { results?: QlooRecord[] };
type InsightsBody = { results?: { entities?: QlooRecord[] } };
type TagsBody = { results?: { tags?: { id: string; name: string; type?: string }[] } };

/**
 * Remember every brand or place we show, so saving a pick needs no Qloo call. Written in the
 * background (Neon writes are slow from far away) and only for ids we haven't stored recently;
 * saving falls back to `ensureEntities` if a write hasn't landed yet.
 */
const stored = new Map<string, number>();
const STORE_EVERY_MS = 6 * 3_600_000;

function rowOf(r: QlooRecord, kind: "BRAND" | "PLACE") {
  const card = kind === "BRAND" ? brandCard(r) : placeCard(r);
  return { kind, name: r.name, popularity: r.popularity ?? null, imageUrl: card.image ?? null, properties: { card, tags: (r.tags ?? []).map((t) => ({ type: t.type, id: t.tag_id ?? t.id, name: t.name })) } as object, fetchedAt: new Date() };
}

function remember(records: QlooRecord[], kind: "BRAND" | "PLACE") {
  const now = Date.now();
  const fresh = records.filter((r) => now - (stored.get(r.entity_id) ?? 0) > STORE_EVERY_MS);
  if (!fresh.length) return;
  for (const r of fresh) stored.set(r.entity_id, now);
  void prisma
    .$transaction(fresh.map((r) => prisma.qlooEntity.upsert({ where: { id: r.entity_id }, create: { id: r.entity_id, ...rowOf(r, kind) }, update: rowOf(r, kind) })))
    .catch((error) => {
      for (const r of fresh) stored.delete(r.entity_id);
      logger.warn({ ...errorDetails(error) }, "lookup: could not store entities");
    });
}

/** Make sure picked ids are stored, fetching any record that isn't (from cache when possible). */
export async function ensureEntities(picks: { id: string; kind: "brand" | "place" }[]) {
  const have = new Set((await prisma.qlooEntity.findMany({ where: { id: { in: picks.map((p) => p.id) } }, select: { id: true } })).map((e) => e.id));
  const missing = picks.filter((p) => !have.has(p.id));
  const unknown: string[] = [];
  await Promise.all(
    missing.map(async (p) => {
      const record = await recordOf(p.id).catch(() => null);
      if (!record) return void unknown.push(p.id);
      const kind = p.kind === "place" ? "PLACE" : "BRAND";
      await prisma.qlooEntity.upsert({ where: { id: record.entity_id }, create: { id: record.entity_id, ...rowOf(record, kind) }, update: rowOf(record, kind) });
    }),
  );
  return unknown;
}

async function searchRecords(query: string, type: string, extra: Record<string, string | number> = {}, take = 8) {
  const body = await qloo<SearchBody>("/search", { query, types: type, take, ...extra }, type === PLACE ? TTL.placeSearch : TTL.brandSearch);
  return body.results ?? [];
}

/** The full record for one entity (brand or place), from cache when we have it. */
export async function recordOf(id: string): Promise<QlooRecord | null> {
  const body = await qloo<{ results?: QlooRecord[] }>("/entities", { entity_ids: id }, TTL.record);
  return body.results?.[0] ?? null;
}

/** Brands matching what the owner typed. An exact match goes first. */
export async function searchBrands(query: string) {
  const results = await searchRecords(query, BRAND);
  const best = bestMatch(results, query);
  const ordered = best ? [best, ...results.filter((r) => r !== best)] : results;
  const top = ordered.slice(0, 6);
  remember(top, "BRAND");
  return top.map(brandCard);
}

/** Towns and cities in the workspace's market, for finding a shop. Never trusts a bare name: "Brighton" is also in the US. */
export async function searchLocalities(query: string, market: Market) {
  const country = countryName(market) === "United States" ? "United States of America" : countryName(market);
  // Naming the country in the query ranks its towns first; the filter below drops the rest.
  const results = await searchRecords(`${query}, ${country}`, "urn:entity:locality", {}, 12);
  return results
    .filter((r) => String((r as { disambiguation?: string }).disambiguation ?? "").includes(country))
    .slice(0, 6)
    .map((r) => ({ id: r.entity_id, name: r.name, detail: (r as { disambiguation?: string }).disambiguation ?? "", location: r.location }));
}

/** Shops, cafés and restaurants near a point. */
export async function searchPlaces(query: string, near: { lat: number; lon: number }) {
  const results = await searchRecords(query, PLACE, { "filter.location": `${near.lat},${near.lon}`, "filter.radius": 15 });
  const top = results.slice(0, 6);
  remember(top, "PLACE");
  return top.map(placeCard);
}

/** Resolve a suggested name to a Qloo brand, the way a person would pick it from search. */
async function resolveBrand(name: string) {
  const results = await searchRecords(name, BRAND, {}, 5);
  return bestMatch(results, name);
}

function judge(source: QlooRecord, match: QlooRecord | null, name: string, market: Market, needSameCategory: boolean): Suggestion {
  if (!match || slug(match.name) === slug(source.name) || (needSameCategory && !sharesCategory(source, match))) return { name, status: "not_found" };
  return { name: match.name, status: sellsIn(match, market) ? "ok" : "other_market", card: brandCard(match) };
}

const unique = (list: Suggestion[]) => {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = s.card?.id ?? `name:${slug(s.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Rivals and read-through brands from a brand's own Qloo record. */
export async function brandSuggestions(id: string, market: Market) {
  const record = await recordOf(id);
  if (!record) return null;
  const own = slug(record.name);
  const competitors = tagsOf(record, "competitor_brand:qloo").filter((n) => slug(n) !== own);
  const similar = tagsOf(record, "similar_brand:qloo").filter((n) => slug(n) !== own);
  const [cMatches, sMatches] = await Promise.all([Promise.all(competitors.map(resolveBrand)), Promise.all(similar.map(resolveBrand))]);
  const rivals = unique(competitors.map((n, i) => judge(record, cMatches[i] ?? null, n, market, true)));
  const seeds = unique(similar.map((n, i) => judge(record, sMatches[i] ?? null, n, market, false)));
  remember([...cMatches, ...sMatches].filter((r): r is QlooRecord => Boolean(r)), "BRAND");
  const ids = tagIdsOf(record, "product_category:qloo");
  const names = tagsOf(record, "product_category:qloo");
  return {
    categories: names.length ? names.map((name, i) => ({ id: ids[i] ?? null, name })) : categoriesOf(record).map((name) => ({ id: null, name })),
    rivals,
    seeds,
  };
}

/** Same-kind places nearby that share its customers, and the brands its customers like. */
export async function placeSuggestions(id: string, market: Market) {
  const record = await recordOf(id);
  if (!record?.location) return null;
  const { lat, lon } = record.location;
  const genre = primaryGenreId(record);
  const own = slug(record.name);
  const genres = new Set(placeGenres(record));
  const [near, brands] = await Promise.all([
    qloo<InsightsBody>(
      "/v2/insights",
      { "filter.type": PLACE, "signal.interests.entities": id, "filter.location": `POINT(${lon} ${lat})`, "filter.location.radius": 5000, ...(genre ? { "filter.tags": genre } : {}), take: 20 },
      TTL.insights,
    ),
    qloo<InsightsBody>("/v2/insights", { "filter.type": BRAND, "signal.interests.entities": id, take: 15 }, TTL.insights),
  ]);
  const places = (near.results?.entities ?? [])
    .filter((p) => !slug(p.name).startsWith(own) && !own.startsWith(slug(p.name)))
    .filter((p) => placeGenres(p).some((g) => genres.has(g)))
    // Same main business first (an ice cream shop before a waffle bar that also sells ice cream).
    .sort((a, b) => Number(primaryGenreId(a) !== genre) - Number(primaryGenreId(b) !== genre))
    .slice(0, 8);
  const liked = (brands.results?.entities ?? []).filter((b) => sellsIn(b, market)).slice(0, 8);
  remember(places, "PLACE");
  remember(liked, "BRAND");
  return {
    categories: placeGenres(record).slice(0, 3).map((name) => ({ id: null, name })),
    rivals: places.map((p): Suggestion => ({ name: p.name, status: "ok", card: placeCard(p) })),
    seeds: liked.map((b): Suggestion => ({ name: b.name, status: "ok", card: brandCard(b) })),
  };
}

/** Plain words ("small-batch ice cream") to Qloo product categories. */
export async function searchCategories(words: string) {
  const body = await qloo<TagsBody>(
    "/v2/tags",
    { "filter.query": words, "filter.tag.types": "urn:tag:product_category:qloo", "feature.semantic_search": "true", take: 5 },
    TTL.tags,
  );
  return (body.results?.tags ?? []).slice(0, 4).map((t) => ({ id: t.id, name: t.name }));
}

/** The best-known brands in a category: in the market first, then anywhere, labelled. */
export async function categoryBrands(tagId: string, market: Market) {
  const inMarket = await qloo<InsightsBody>(
    "/v2/insights",
    { "filter.type": BRAND, "filter.tags": `${tagId},${MARKET_TAG[market]}`, "operator.filter.tags": "intersection", take: 8 },
    TTL.insights,
  );
  let records = inMarket.results?.entities ?? [];
  let scope: "market" | "any" = "market";
  if (records.length < 3) {
    const any = await qloo<InsightsBody>("/v2/insights", { "filter.type": BRAND, "filter.tags": tagId, take: 8 }, TTL.insights);
    const extra = (any.results?.entities ?? []).filter((r) => !records.some((x) => x.entity_id === r.entity_id));
    records = [...records, ...extra].slice(0, 8);
    scope = "any";
  }
  remember(records, "BRAND");
  return { scope, brands: records.map((r): Suggestion => ({ name: r.name, status: sellsIn(r, market) ? "ok" : "other_market", card: brandCard(r) })) };
}
