/**
 * Runs the onboarding lookups against live Qloo (through the cache) and prints what a person
 * would see. A quick end-to-end check after changing src/modules/lookup.
 *
 *   pnpm lookup:smoke
 */
import { connectRedis, disconnectRedis } from "@/infra/redis";
import { disconnectDatabase } from "@/infra/database";
import {
  brandSuggestions,
  categoryBrands,
  placeSuggestions,
  searchBrands,
  searchCategories,
  searchLocalities,
  searchPlaces,
} from "@/modules/lookup/lookup.service";

const line = (label: string, value: unknown) => console.log(`${label.padEnd(28)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function main() {
  await connectRedis().catch(() => console.log("(redis not reachable: using postgres cache only)"));
  const t0 = Date.now();

  const judes = await searchBrands("Jude's");
  line("brands: Jude's", judes.map((b) => `${b.name} [${b.categories.join(", ")}] ${b.markets.join("/")}`));
  line("brands: Magnum", (await searchBrands("Magnum")).map((b) => `${b.name} [${b.categories.join(", ")}]`));

  const first = judes[0];
  if (first) {
    const s = await brandSuggestions(first.id, "GB");
    line(`suggestions: ${first.name}`, { categories: s?.categories.map((c) => c.name), rivals: s?.rivals.map((r) => `${r.name}:${r.status}`), seeds: s?.seeds.map((r) => `${r.name}:${r.status}`) });
  }

  const brighton = await searchLocalities("Brighton", "GB");
  line("localities: Brighton (GB)", brighton.map((l) => l.detail));
  const town = brighton[0];
  if (town?.location) {
    const shops = await searchPlaces("Boho Gelato", town.location);
    line("places: Boho Gelato", shops.map((p) => `${p.name} · ${p.address} · ${p.categories.join(", ")}`));
    if (shops[0]) {
      const s = await placeSuggestions(shops[0].id, "GB");
      line("suggestions: Boho Gelato", { rivals: s?.rivals.map((r) => r.name), seeds: s?.seeds.map((r) => r.name) });
    }
  }

  const cats = await searchCategories("mochi ice cream and sorbets");
  line("categories: mochi…", cats.map((c) => c.name));
  if (cats[0]?.id) {
    const big = await categoryBrands(cats[0].id, "GB");
    line(`big brands: ${cats[0].name}`, { scope: big.scope, brands: big.brands.map((b) => `${b.name}:${b.status}`) });
  }
  line("time", `${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectRedis();
    await disconnectDatabase();
  });
