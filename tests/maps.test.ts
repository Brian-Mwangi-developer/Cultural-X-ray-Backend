import { describe, expect, it } from "vitest";
import { CATEGORIES, type Entity, entitiesOf, insightsParams, readingFor, splitTerritory, warningsOf } from "@/modules/maps/map.shape";

// Names and affinities from real answers saved in test/map-build/json.
const e = (name: string, affinity: number): Entity => ({ id: name, name, popularity: 0.9, affinity, image: null, detail: null });
const podcasts = CATEGORIES.find((c) => c.kind === "PODCAST")!;
const places = CATEGORIES.find((c) => c.kind === "DESTINATION")!;
const rivalName = (id: string) => ({ bj: "Ben & Jerry's", hd: "Häagen-Dazs" })[id] ?? "a rival";

describe("maps: asking Qloo", () => {
  it("localises lists to the market, and keeps places inside the country", () => {
    expect(insightsParams(podcasts, ["a", "b"], "GB")).toMatchObject({ "filter.type": "urn:entity:podcast", "signal.interests.entities": "a,b", "signal.location.query": "United Kingdom" });
    const p = insightsParams(places, ["a"], "US");
    expect(p["filter.geocode.country_code"]).toBe("US");
    expect(p).not.toHaveProperty("signal.location.query");
  });

  it("drops the brands being compared, unusable rows, and reads images and regions", () => {
    const body = {
      results: {
        entities: [
          { entity_id: "judes", name: "Jude's", popularity: 0.6, query: { affinity: 0.9 } },
          { entity_id: "x", name: "Ghost", popularity: 0, query: { affinity: 0.9 } },
          { entity_id: "rh", name: "RedHanded", popularity: 0.99, query: { affinity: 0.97 }, properties: { image: { url: "https://images.qloo.com/i/rh" } } },
          { entity_id: "sh", name: "Shrewsbury", popularity: 0.31, query: { affinity: 0.97 }, properties: { geocode: { admin1_region: "England", admin2_region: "Shropshire" } } },
        ],
      },
    };
    const out = entitiesOf(body, new Set(["judes"]));
    expect(out.map((x) => x.name)).toEqual(["RedHanded", "Shrewsbury"]);
    expect(out[0]?.image).toBe("https://images.qloo.com/i/rh");
    expect(out[1]?.detail).toBe("Shropshire, England");
  });

  it("treats a 200 with warnings as a warning", () => {
    expect(warningsOf({ warnings: [{ type: "not_found" }] })).toHaveLength(1);
    expect(warningsOf({ results: {} })).toBeNull();
  });
});

describe("maps: territory", () => {
  const yours = [e("RedHanded", 0.98), e("All Killa No Filla", 0.95), e("Real Crime Profile", 0.9)];
  const rivals = new Map([
    ["bj", [e("Getting Curious", 0.97), e("RedHanded", 0.6)]],
    ["hd", [e("Getting Curious", 0.99), e("This Might Get Weird", 0.9)]],
  ]);

  it("labels each item yours, contested or theirs", () => {
    const split = splitTerritory(yours, rivals);
    const label = (name: string) => split.find((s) => s.entity.name === name)?.label;
    expect(label("All Killa No Filla")).toBe("YOURS");
    expect(label("RedHanded")).toBe("CONTESTED");
    expect(label("Getting Curious")).toBe("THEIRS");
    expect(label("This Might Get Weird")).toBe("THEIRS");
    expect(split).toHaveLength(5);
  });

  it("leans contested items toward the side that ranks them higher, and credits the strongest rival", () => {
    const split = splitTerritory(yours, rivals);
    const red = split.find((s) => s.entity.name === "RedHanded")!;
    expect(red.rival).toBe("bj");
    // First of three for you (1.0), second of two for Ben & Jerry's (0.5).
    expect(red.lean).toBeCloseTo(1 / 1.5);
    expect(split.find((s) => s.entity.name === "Getting Curious")?.rival).toBe("hd");
  });

  it("calls everything yours when there are no rivals", () => {
    expect(splitTerritory(yours, new Map()).every((s) => s.label === "YOURS")).toBe(true);
  });
});

describe("maps: readings", () => {
  it("names the top three and who shares them", () => {
    const text = readingFor(podcasts, splitTerritory([e("RedHanded", 0.98), e("All Killa No Filla", 0.95), e("Real Crime Profile", 0.9)], new Map([["bj", [e("RedHanded", 0.6)]]])), rivalName);
    expect(text).toBe("Your customers listen to RedHanded, All Killa No Filla and Real Crime Profile. RedHanded is shared with Ben & Jerry's.");
  });

  it("counts shared items and names the rival sharing most", () => {
    const mine = [e("A", 1), e("B", 1), e("C", 1), e("D", 1)];
    const text = readingFor(podcasts, splitTerritory(mine, new Map([["bj", [e("B", 1), e("C", 1)]], ["hd", [e("D", 1)]]])), rivalName);
    expect(text).toBe("Your customers listen to A, B and C. 3 of these podcasts are shared, most with Ben & Jerry's.");
  });

  it("says when nothing is shared, and stays quiet when nothing is yours", () => {
    expect(readingFor(places, splitTerritory([e("Bath", 0.9)], new Map([["bj", [e("Cowes", 0.9)]]])), rivalName)).toBe("Your customers go to Bath. None of it is shared with your rivals.");
    expect(readingFor(places, splitTerritory([], new Map([["bj", [e("Cowes", 0.9)]]])), rivalName)).toBeNull();
  });
});
