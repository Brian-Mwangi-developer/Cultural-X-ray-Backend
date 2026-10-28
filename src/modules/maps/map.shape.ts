/**
 * The Culture Map's rules, with no I/O: which categories a map reads, how lists from your side
 * and your rivals' become yours / contested / theirs, and the sentence each category gets.
 * Rules come from the map-build lab (test/map-build) and are covered by tests/maps.test.ts.
 */

export type Market = "GB" | "US";
export type Kind = "PODCAST" | "MOVIE" | "TV_SHOW" | "PERSON" | "ARTIST" | "DESTINATION" | "BRAND" | "BOOK";
export type Label = "YOURS" | "CONTESTED" | "THEIRS";

export type Category = { kind: Kind; urn: string; label: string; noun: string; verb: string };

/** In build order: the categories the overview shows first are read first. */
export const CATEGORIES: Category[] = [
  { kind: "PODCAST", urn: "urn:entity:podcast", label: "Podcasts", noun: "podcasts", verb: "listen to" },
  { kind: "MOVIE", urn: "urn:entity:movie", label: "Films", noun: "films", verb: "watch" },
  { kind: "TV_SHOW", urn: "urn:entity:tv_show", label: "TV", noun: "TV shows", verb: "watch" },
  { kind: "DESTINATION", urn: "urn:entity:destination", label: "Places", noun: "places", verb: "go to" },
  { kind: "PERSON", urn: "urn:entity:person", label: "Creators", noun: "creators", verb: "follow" },
  { kind: "ARTIST", urn: "urn:entity:artist", label: "Artists", noun: "artists", verb: "listen to" },
  { kind: "BRAND", urn: "urn:entity:brand", label: "Brands", noun: "brands", verb: "also buy" },
  { kind: "BOOK", urn: "urn:entity:book", label: "Books", noun: "books", verb: "read" },
];

export const categoryOf = (kind: string) => CATEGORIES.find((c) => c.kind === kind);

const COUNTRY: Record<Market, string> = { GB: "United Kingdom", US: "United States" };

/**
 * One insights call for one side. Lists are localised to the market: without it a global rival
 * reads as its home country (Häagen-Dazs came back Japanese for a UK map). Destinations are
 * kept inside the country instead, since a location signal there would only bias, not filter.
 */
export function insightsParams(category: Category, signalIds: string[], market: Market, take = 20): Record<string, string | number> {
  const base = { "filter.type": category.urn, "signal.interests.entities": signalIds.join(","), take };
  return category.kind === "DESTINATION" ? { ...base, "filter.geocode.country_code": market } : { ...base, "signal.location.query": COUNTRY[market] };
}

/* ---------------------------------------------------------------- filters */

/**
 * The Culture Map's filters. Each filtered view is the same comparison with one more signal, built
 * the first time someone asks for it and stored beside the base map (territory rows carry the
 * segment and tier). Probe of 28 October on Jude's UK map: age bands change the lists for real
 * (over-55s: RedHanded, Gretchen Rubin, Home Cooking), two bands combine in one call, and Qloo's
 * popularity sits near 1 for almost everything, so "niche" is popularity under 0.8 (16 podcasts;
 * under 0.5 returned none).
 */
export const AGES = [
  { key: "", label: "Everyone", value: null },
  { key: "age:under_25", label: "Under 25", value: "24_and_younger" },
  { key: "age:25_34", label: "25–34", value: "25_to_29,30_to_34" },
  { key: "age:35_44", label: "35–44", value: "35_to_44" },
  { key: "age:45_54", label: "45–54", value: "45_to_54" },
  { key: "age:55_plus", label: "55 and over", value: "55_and_older" },
] as const;
export type AgeKey = (typeof AGES)[number]["key"];
export type Tier = "MAINSTREAM" | "NICHE";
export const NICHE_POPULARITY_MAX = 0.8;
export type Variant = { segment: AgeKey; tier: Tier };
export const BASE: Variant = { segment: "", tier: "MAINSTREAM" };
export const isBase = (v: Variant) => v.segment === "" && v.tier === "MAINSTREAM";
/**
 * The base map's rows only. Filtered views live in the same tables (their own segment and tier), so
 * every query that means "the map" filters on this; without it they double-count (an overview listed
 * a podcast twice once an age view existed).
 */
export const BASE_ROWS = { segment: "", tier: "MAINSTREAM" } as const;

/** The extra parameters a filtered view adds to each insights call. */
export function variantParams(v: Variant): Record<string, string | number> {
  const age = AGES.find((a) => a.key === v.segment)?.value;
  return { ...(age ? { "signal.demographics.age": age } : {}), ...(v.tier === "NICHE" ? { "filter.popularity.max": NICHE_POPULARITY_MAX } : {}) };
}

export type Entity = { id: string; name: string; popularity: number | null; affinity: number; image: string | null; detail: string | null; location: { lat: number; lon: number } | null };

type Raw = {
  entity_id?: string;
  name?: string;
  popularity?: number;
  disambiguation?: string;
  query?: { affinity?: number };
  location?: { lat?: number; lon?: number };
  properties?: { image?: { url?: string }; geocode?: { admin1_region?: string; admin2_region?: string } };
};

/** Insights entities as the map stores them. Unusable rows (no id, popularity 0) are dropped. */
export function entitiesOf(body: unknown, exclude: Set<string>): Entity[] {
  const list = ((body as { results?: { entities?: Raw[] } })?.results?.entities ?? []) as Raw[];
  const out: Entity[] = [];
  for (const e of list) {
    if (!e.entity_id || !e.name || exclude.has(e.entity_id) || e.popularity === 0) continue;
    const geo = e.properties?.geocode;
    out.push({
      id: e.entity_id,
      name: e.name,
      popularity: typeof e.popularity === "number" ? e.popularity : null,
      affinity: typeof e.query?.affinity === "number" ? e.query.affinity : 0,
      image: e.properties?.image?.url ?? null,
      detail: geo ? [geo.admin2_region, geo.admin1_region].filter(Boolean).join(", ") || null : e.disambiguation || null,
      location: typeof e.location?.lat === "number" && typeof e.location?.lon === "number" ? { lat: e.location.lat, lon: e.location.lon } : null,
    });
  }
  return out;
}

/** Qloo answers 200 with `warnings` when it silently dropped a signal. */
export const warningsOf = (body: unknown) => {
  const w = (body as { warnings?: unknown })?.warnings;
  return Array.isArray(w) && w.length ? w : null;
};

export type Split = { entity: Entity; label: Label; rival: string | null; lean: number | null; rank: number };

/**
 * Compare one category's lists. `yours` is your side's list; `rivals` maps each rival's subject
 * id to its list. Qloo's affinities bunch up near 1 (0.95–0.99 in the lab), so a shared item's
 * lean comes from where it ranks on each side instead: your share, 0–1, where 0.5 is even.
 * With no rivals everything is yours: there's nothing to contest.
 */
export function splitTerritory(yours: Entity[], rivals: Map<string, Entity[]>): Split[] {
  const standing = (rank: number, length: number) => 1 - rank / Math.max(length, 1);
  const out: Split[] = [];
  const theirs = new Map<string, { entity: Entity; rival: string; rank: number; score: number }>();
  for (const [rival, list] of rivals) {
    list.forEach((entity, rank) => {
      const score = standing(rank, list.length);
      const seen = theirs.get(entity.id);
      if (!seen || score > seen.score || (score === seen.score && entity.affinity > seen.entity.affinity)) theirs.set(entity.id, { entity, rival, rank, score });
    });
  }
  yours.forEach((entity, rank) => {
    const shared = theirs.get(entity.id);
    if (!shared) return void out.push({ entity, label: "YOURS", rival: null, lean: null, rank });
    const mine = standing(rank, yours.length);
    out.push({ entity, label: "CONTESTED", rival: shared.rival, lean: mine / (mine + shared.score), rank });
    theirs.delete(entity.id);
  });
  for (const { entity, rival, rank } of theirs.values()) out.push({ entity, label: "THEIRS", rival, lean: null, rank: yours.length + rank });
  return out;
}

const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * The one-line reading for a category, built only from what the lists say. No adjectives we
 * can't back: names, who holds them, and who they're shared with.
 */
export function readingFor(category: Category, split: Split[], rivalName: (subjectId: string) => string): string | null {
  const mine = split.filter((s) => s.label !== "THEIRS").sort((a, b) => a.rank - b.rank);
  if (!mine.length) return null;
  const lead = `Your customers ${category.verb} ${list(mine.slice(0, 3).map((s) => s.entity.name))}.`;
  const contested = mine.filter((s) => s.label === "CONTESTED");
  const top = contested[0];
  if (!top) return split.some((s) => s.label === "THEIRS") ? `${lead} None of it is shared with your rivals.` : lead;
  const who = rivalName(top.rival!);
  if (contested.length === 1) return `${lead} ${top.entity.name} is shared with ${who}.`;
  const tally = new Map<string, number>();
  for (const s of contested) tally.set(s.rival!, (tally.get(s.rival!) ?? 0) + 1);
  const most = rivalName([...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
  return `${lead} ${contested.length} of these ${category.noun} are shared, most with ${most}.`;
}

/* ---------------------------------------------------------------- audience */

/** Who a brand reaches. One call per segment scores every brand on the map at once. */
export const SEGMENTS = [
  { key: "age:24_and_younger", param: "signal.demographics.age", value: "24_and_younger", label: "Under 25" },
  { key: "age:25_to_29", param: "signal.demographics.age", value: "25_to_29", label: "25–29" },
  { key: "age:30_to_34", param: "signal.demographics.age", value: "30_to_34", label: "30–34" },
  { key: "age:35_to_44", param: "signal.demographics.age", value: "35_to_44", label: "35–44" },
  { key: "age:45_to_54", param: "signal.demographics.age", value: "45_to_54", label: "45–54" },
  { key: "age:55_and_older", param: "signal.demographics.age", value: "55_and_older", label: "55 and over" },
  { key: "gender:female", param: "signal.demographics.gender", value: "female", label: "Women" },
  { key: "gender:male", param: "signal.demographics.gender", value: "male", label: "Men" },
] as const;

export type Segment = (typeof SEGMENTS)[number];

/**
 * No location signal here: with one, scores bunch near 1 and some brands drop out entirely
 * (Häagen-Dazs vanished from a UK panel in the map-build lab).
 */
export const audienceParams = (segment: Segment, ids: string[]): Record<string, string | number> => ({
  "filter.type": "urn:entity:brand",
  "filter.results.entities": ids.join(","),
  [segment.param]: segment.value,
  take: Math.max(10, ids.length),
});

/** Qloo's fill values for "no data" (0.554054 and 0.76 recur across unrelated brands in every lab). */
const FILLERS = [0.554054, 0.76];
export const isFiller = (v: number) => FILLERS.some((f) => Math.abs(v - f) < 5e-6);

export type Score = { value: number | null; masked: boolean; lowConfidence: boolean };

/** One brand's score for one segment, with Qloo's traps handled. */
export function scoreOf(segment: Segment, affinity: number | undefined): Score {
  if (typeof affinity !== "number") return { value: null, masked: false, lowConfidence: false };
  if (isFiller(affinity)) return { value: null, masked: true, lowConfidence: false };
  // Older bands cluster at 0.55–0.66 when Qloo has little signal for them (brand lab).
  const older = segment.value === "45_to_54" || segment.value === "55_and_older";
  return { value: affinity, masked: false, lowConfidence: older && affinity >= 0.55 && affinity <= 0.66 };
}

export function scoresIn(body: unknown, segment: Segment): Map<string, Score> {
  const list = ((body as { results?: { entities?: Raw[] } })?.results?.entities ?? []) as Raw[];
  return new Map(list.filter((e) => e.entity_id).map((e) => [e.entity_id!, scoreOf(segment, e.query?.affinity)]));
}
