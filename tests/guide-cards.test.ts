import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARDS, JOURNEY_IDS, PRODUCT_INDEX } from "@/modules/guide/guide.cards";

// The web app sits beside the backend in this workspace; on a machine with only the backend, skip.
const WEB = join(__dirname, "../../web/src");
const hasWeb = existsSync(join(WEB, "lib/guide.ts"));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("guide: what the assistant knows about the product stays true to the web", () => {
  const parts = Object.values(CARDS).flatMap((c) => c.parts.map((p) => p.id));

  it("names each part once and keeps the index short", () => {
    expect(new Set(parts).size).toBe(parts.length);
    expect(PRODUCT_INDEX.split("\n").length).toBeLessThanOrEqual(12);
  });

  it.runIf(hasWeb)("has the same parts as the web's registry, and every one is tagged on a page", () => {
    const registry = readFileSync(join(WEB, "lib/guide.ts"), "utf8");
    const anchors = [...registry.matchAll(/^\s+"([a-z]+\.[a-z]+)": \{ page:/gm)].map((m) => m[1]);
    expect([...anchors].sort()).toEqual([...parts].sort());

    const source = files(join(WEB, "components")).map((f) => readFileSync(f, "utf8")).join("\n");
    const tagged = (id: string) => source.includes(`data-guide="${id}"`) || source.includes(`"${id}"`);
    expect(parts.filter((id) => !tagged(id))).toEqual([]);
  });

  it.runIf(hasWeb)("has the same walk-throughs as the web", () => {
    const registry = readFileSync(join(WEB, "lib/guide.ts"), "utf8");
    for (const id of JOURNEY_IDS) expect(registry).toMatch(new RegExp(`id: "${id}"`));
  });
});
