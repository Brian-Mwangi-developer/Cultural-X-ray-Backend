import { describe, expect, it } from "vitest";
import { bestMatch, brandCard, categoriesOf, type QlooRecord, sellsIn, sharesCategory, slug } from "@/modules/lookup/qloo.shape";
import { cacheKey } from "@/modules/lookup/cache";
import { normaliseSite } from "@/modules/lookup/site";

// Shapes taken from real Qloo responses saved in test/onboarding-lookup/json.
const tag = (type: string, name: string) => ({ type: `urn:tag:${type}`, name, tag_id: `urn:tag:${type}:${slug(name)}` });
const brand = (name: string, tags: ReturnType<typeof tag>[], properties: Record<string, unknown> = {}): QlooRecord => ({ entity_id: crypto.randomUUID(), name, tags, properties });

const judes = brand("Jude’s Ice Cream", [tag("product_category:qloo", "Ice Cream"), tag("industry:qloo", "Food & Beverage"), tag("key_market:qloo", "United Kingdom")]);
const haagen = brand("Häagen-Dazs", [tag("product_category:qloo", "Ice Cream"), tag("key_market:qloo", "United States"), tag("key_market:qloo", "International")]);
const talenti = brand("Talenti Gelato", [tag("product_category:qloo", "Frozen Desserts"), tag("key_market:qloo", "United States")]);
const oppo = brand("OPPO", [tag("industry:qloo", "Consumer Electronics"), tag("key_market:qloo", "China")]);
const dunkin = brand("Dunkin' Donuts", [tag("product_category:qloo", "Coffee")]);
const ikea = brand("IKEA", [tag("industry:qloo", "Furniture")]);

describe("lookup: matching names", () => {
  it("ignores accents, case and punctuation", () => {
    expect(bestMatch([haagen], "Haagen Dazs")).toBe(haagen);
    expect(bestMatch([judes], "jude's ice cream")).toBe(judes);
  });

  it("matches the stored name when the query is its start", () => {
    expect(bestMatch([dunkin], "Dunkin'")).toBe(dunkin);
  });

  it("matches akas", () => {
    const gails = brand("GAIL's Bakery", [], { akas: [{ value: "Gail's" }] });
    expect(bestMatch([gails], "Gail's")).toBe(gails);
  });

  it("doesn't prefix-match very short queries", () => {
    expect(bestMatch([oppo], "Op")).toBeNull();
  });
});

describe("lookup: suggestion rules", () => {
  it("treats a name that resolves to another kind of business as not comparable", () => {
    // "Oppo Brothers" (ice cream) resolves to OPPO (phones): no shared category.
    expect(sharesCategory(judes, oppo)).toBe(false);
    expect(sharesCategory(judes, haagen)).toBe(true);
  });

  it("sets aside brands that don't sell in the market, but not vague ones", () => {
    expect(sellsIn(talenti, "GB")).toBe(false);
    expect(sellsIn(haagen, "GB")).toBe(true); // "International"
    expect(sellsIn(judes, "GB")).toBe(true);
    expect(sellsIn(brand("No markets", []), "GB")).toBe(true);
  });

  it("falls back to industry when a brand has no product category", () => {
    expect(categoriesOf(ikea)).toEqual(["Furniture"]);
    expect(brandCard(judes).markets).toEqual(["UK"]);
  });
});

describe("lookup: inputs", () => {
  it("normalises websites and refuses non-public addresses", () => {
    expect(normaliseSite("pebbleandcone.co.uk/shop")).toEqual({ url: "https://pebbleandcone.co.uk", domain: "pebbleandcone.co.uk" });
    expect(normaliseSite("https://www.littlemoons.com").domain).toBe("littlemoons.com");
    for (const bad of ["localhost:3000", "http://127.0.0.1", "not a site", "printer.local"]) expect(() => normaliseSite(bad)).toThrow();
  });

  it("keys the cache by path and sorted params", () => {
    expect(cacheKey("/search", { a: 1, b: 2 })).toBe(cacheKey("/search", { b: 2, a: 1 }));
    expect(cacheKey("/search", { a: 1 })).not.toBe(cacheKey("/v2/tags", { a: 1 }));
  });
});
