import rows from "./towns.data.json" with { type: "json" };

/**
 * Town search for onboarding, without Qloo. Only the town's name and location are used later (the
 * shops near it, the brand's city), and Qloo's locality search took 2–30 s per query on 28 October,
 * sometimes past the proxy's limit. These are GeoNames' UK and US places with 1,000+ people
 * (CC BY 4.0; built by scripts/build-towns.py): instant, free, and never down.
 */

type Row = [id: number, name: string, region: string, country: "GB" | "US", lat: number, lon: number, population: number];
export type Town = { id: string; name: string; detail: string; location: { lat: number; lon: number } };

const COUNTRY = { GB: "United Kingdom", US: "United States" } as const;
const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const TOWNS = (rows as Row[]).map((r) => ({ row: r, key: fold(r[1]) }));

/** Towns in the market whose name starts with the query (then contains it), biggest first. */
export function searchTowns(query: string, market: "GB" | "US", take = 6): Town[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const here = TOWNS.filter((t) => t.row[3] === market);
  const starts = here.filter((t) => t.key.startsWith(q));
  const within = starts.length >= take ? [] : here.filter((t) => !t.key.startsWith(q) && t.key.includes(` ${q}`));
  // Rows are stored most populous first, so the order is already right within each group.
  const exact = starts.filter((t) => t.key === q);
  const picked = [...exact, ...starts.filter((t) => t.key !== q), ...within].slice(0, take);
  return picked.map(({ row: [id, name, region, country, lat, lon] }) => ({
    id: `geonames:${id}`,
    name,
    detail: [name, region, COUNTRY[country]].filter(Boolean).join(", "),
    location: { lat, lon },
  }));
}
