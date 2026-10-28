import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/infra/database";
import { parseView } from "@/modules/maps/map.view";
import { AGES, isBase, variantParams } from "@/modules/maps/map.shape";
import { recordQlooCall, withMeter } from "@/modules/usage/meter";
import { DEFAULT_ALLOWANCE, usageOf } from "@/modules/usage/usage.service";

const tag = randomUUID().slice(0, 8);
let brand = "";
let client = "";
let agency = "";

beforeAll(async () => {
  const make = (kind: "WORKSPACE" | "AGENCY", name: string) => prisma.organization.create({ data: { id: randomUUID(), name, slug: `meter-${name.toLowerCase()}-${tag}`, kind }, select: { id: true } });
  const [b, c, a] = await Promise.all([make("WORKSPACE", "Brand"), make("WORKSPACE", "Client"), make("AGENCY", "Agency")]);
  [brand, client, agency] = [b.id, c.id, a.id];
  // The agency pays for this client: the client's queries come out of the agency's pool.
  await prisma.subscription.create({ data: { organizationId: client, payerId: agency, plan: "AGENCY", monthlyQueryAllowance: 10_000 } });
});

afterAll(async () => {
  await prisma.usageLedger.deleteMany({ where: { workspaceId: { in: [brand, client, agency] } } });
  await prisma.subscription.deleteMany({ where: { organizationId: client } });
  await prisma.organization.deleteMany({ where: { id: { in: [brand, client, agency] } } });
});

describe("usage: counting Qloo queries per account", () => {
  it("counts calls that reach Qloo, notes cache hits as free, and ignores calls outside any account", async () => {
    await recordQlooCall("/v2/insights", false); // no meter: nobody to charge
    await withMeter({ workspaceId: brand, kind: "MAP_BUILD", userId: null }, async () => {
      await recordQlooCall("/v2/insights", false);
      await recordQlooCall("/v2/insights", false);
      await recordQlooCall("/v2/insights", true);
    });
    const u = await usageOf(brand);
    expect(u).toMatchObject({ used: 2, cacheHits: 1, allowance: DEFAULT_ALLOWANCE.WORKSPACE, payer: { id: brand, self: true } });
    expect(u.byKind).toEqual([{ kind: "MAP_BUILD", calls: 2 }]);
  });

  it("charges a client's queries to the agency that pays for it", async () => {
    await withMeter({ workspaceId: client, kind: "PLAYS" }, () => recordQlooCall("/entities", false));
    await withMeter({ workspaceId: agency, kind: "LOOKUP" }, () => recordQlooCall("/search", false));
    const forClient = await usageOf(client);
    expect(forClient).toMatchObject({ used: 2, ownUsed: 1, allowance: 10_000, payer: { id: agency, self: false } });
    const forAgency = await usageOf(agency);
    expect(forAgency.used).toBe(2);
    expect(forAgency.byWorkspace.map((w) => w.name).sort()).toEqual(["Agency", "Client"]);
  });

  it("starts each month at zero", async () => {
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2));
    expect((await usageOf(brand, nextMonth)).used).toBe(0);
  });
});

describe("culture map: filtered views", () => {
  it("adds the age signal (two bands in one call) and the niche cap", () => {
    expect(variantParams({ segment: "age:25_34", tier: "MAINSTREAM" })).toEqual({ "signal.demographics.age": "25_to_29,30_to_34" });
    expect(variantParams({ segment: "", tier: "NICHE" })).toEqual({ "filter.popularity.max": 0.8 });
    expect(isBase({ segment: "", tier: "MAINSTREAM" })).toBe(true);
    expect(AGES.map((a) => a.label)).toContain("55 and over");
  });

  it("refuses categories, ages and tiers it doesn't offer", () => {
    expect(parseView({ category: "ARTIST", age: "age:55_plus", tier: "NICHE" })).toEqual({ kind: "ARTIST", variant: { segment: "age:55_plus", tier: "NICHE" } });
    expect(() => parseView({ category: "SNEAKERS" })).toThrow(/category/);
    expect(() => parseView({ category: "PODCAST", age: "age:12" })).toThrow(/age band/);
    expect(() => parseView({ category: "PODCAST", tier: "VIRAL" })).toThrow(/mainstream or niche/);
  });
});
