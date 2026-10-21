/**
 * Reading Qloo records the way onboarding needs them. The rules here come from the lookup lab
 * (test/onboarding-lookup, research-onboarding-lookup.md) and are covered by tests/lookup.test.ts.
 */

export type QlooTag = { tag_id?: string; id?: string; type?: string; name: string };
export type QlooRecord = {
  entity_id: string;
  name: string;
  popularity?: number;
  location?: { lat: number; lon: number };
  tags?: QlooTag[];
  properties?: Record<string, unknown>;
  query?: { affinity?: number; distance?: number };
};

export type Market = "GB" | "US";

/** A brand or place as onboarding shows it. */
export type Card = {
  id: string;
  kind: "brand" | "place";
  name: string;
  categories: string[];
  markets: string[];
  description?: string;
  image?: string;
  address?: string;
  rating?: number;
  priceLevel?: number;
  location?: { lat: number; lon: number };
};

const COUNTRY: Record<Market, string> = { GB: "United Kingdom", US: "United States" };
const SHORT: Record<string, string> = { "United Kingdom": "UK", "United States": "US" };
/** Markets that don't rule a country out. */
const VAGUE = new Set(["Global", "International", "Worldwide", "Europe", "North America", "Asia", "Online"]);
/** Place genres too generic to describe a venue. */
const GENERIC_GENRES = new Set(["Place", "Restaurant", "Point of interest", "Establishment"]);

/** Lowercase, no accents, no punctuation: "Häagen-Dazs" and "Haagen Dazs" match. */
export const slug = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export const tagsOf = (r: QlooRecord, type: string) => (r.tags ?? []).filter((t) => t.type === `urn:tag:${type}`).map((t) => t.name);
export const tagIdsOf = (r: QlooRecord, type: string) => (r.tags ?? []).filter((t) => t.type === `urn:tag:${type}`).map((t) => t.tag_id ?? t.id ?? "");

/** Product categories, else the industry tags (restaurants and some big brands have no product category). */
export function categoriesOf(r: QlooRecord): string[] {
  const product = tagsOf(r, "product_category:qloo");
  return product.length ? product : tagsOf(r, "industry:qloo");
}

export const marketsOf = (r: QlooRecord) => tagsOf(r, "key_market:qloo");

/** Sells in the market, or says something too vague to rule it out. Records with no markets aren't ruled out either. */
export function sellsIn(r: QlooRecord, market: Market) {
  const markets = marketsOf(r);
  return !markets.length || markets.includes(COUNTRY[market]) || markets.some((m) => VAGUE.has(m));
}

/** The result a person would pick for this name: exact (ignoring case and accents), an aka, then a prefix match. */
export function bestMatch(results: QlooRecord[], name: string): QlooRecord | null {
  const q = slug(name);
  if (!q) return null;
  const akas = (r: QlooRecord) => ((r.properties?.akas as unknown[]) ?? []).map((a) => (typeof a === "string" ? a : (a as { value?: string })?.value ?? "")).map(slug);
  const exact = results.find((r) => slug(r.name) === q || akas(r).includes(q));
  if (exact) return exact;
  return q.length >= 4 ? results.find((r) => slug(r.name).startsWith(q) || q.startsWith(slug(r.name))) ?? null : null;
}

/** Same product category or industry: stops "Oppo Brothers" (ice cream) resolving to OPPO (phones). */
export function sharesCategory(a: QlooRecord, b: QlooRecord) {
  const set = (r: QlooRecord) => new Set([...tagsOf(r, "product_category:qloo"), ...tagsOf(r, "industry:qloo").filter((t) => t !== "Food & Beverage" && t !== "Retail")]);
  const sa = set(a);
  for (const t of set(b)) if (sa.has(t)) return true;
  return false;
}

export const shortMarkets = (markets: string[]) => markets.map((m) => SHORT[m] ?? m);

export function brandCard(r: QlooRecord): Card {
  const p = r.properties ?? {};
  const image = (p.image as { url?: string } | undefined)?.url;
  return {
    id: r.entity_id,
    kind: "brand",
    name: r.name,
    categories: categoriesOf(r).slice(0, 3),
    markets: shortMarkets(marketsOf(r)),
    description: (p.short_description as string | undefined) ?? undefined,
    image,
  };
}

export function placeGenres(r: QlooRecord) {
  return tagsOf(r, "genre:place").filter((g) => !GENERIC_GENRES.has(g));
}

export function primaryGenreId(r: QlooRecord): string | undefined {
  return ((r.properties?.primary_genre as { id?: string } | undefined) ?? {}).id;
}

export function placeCard(r: QlooRecord): Card {
  const p = r.properties ?? {};
  return {
    id: r.entity_id,
    kind: "place",
    name: r.name,
    categories: placeGenres(r).slice(0, 3),
    markets: [],
    description: (p.description as string | undefined)?.slice(0, 160),
    image: (p.image as { url?: string } | undefined)?.url,
    address: p.address as string | undefined,
    rating: typeof p.business_rating === "number" ? Math.round(p.business_rating * 10) / 10 : undefined,
    priceLevel: typeof p.price_level === "number" ? p.price_level : undefined,
    location: r.location,
  };
}

export const countryName = (market: Market) => COUNTRY[market];
