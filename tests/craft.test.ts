import { describe, expect, it } from "vitest";
import { craftFindings, type CraftFacts, shapeOf } from "@/modules/adcheck/adcheck.craft";

const base: CraftFacts = { width: 1280, height: 720, durationMs: 24_000, placements: ["tiktok", "reels"], brand: "O'liery Pizza", productKnown: true, productAtMs: 0, onScreen: [{ text: "Order now", kind: "call_to_action", startMs: 20_000 }], spokenLines: 0, hasSound: true };
const ids = (f: Partial<CraftFacts>) => craftFindings({ ...base, ...f }).map((x) => x.id);

describe("ad check: what would hold the ad back where it runs", () => {
  it("knows shapes", () => {
    expect([shapeOf(1080, 1920), shapeOf(1080, 1350), shapeOf(1080, 1080), shapeOf(1920, 1080)]).toEqual(["vertical", "portrait", "square", "landscape"]);
  });

  it("flags a landscape ad for TikTok and Reels once, with the measured size, and nothing for YouTube", () => {
    const [shape] = craftFindings(base);
    expect(shape).toMatchObject({ id: "shape-9:16 vertical", level: "fix", evidence: ["1280 × 720, landscape", "chosen: TikTok and Instagram Reels"] });
    expect(ids({ placements: ["youtube"] })).not.toContain("shape-9:16 vertical");
    expect(ids({ width: 720, height: 1280 })).toEqual([]);
  });

  it("flags a product that shows up after people have scrolled, using YouTube's five seconds", () => {
    expect(ids({ width: 720, height: 1280, productAtMs: 2_000 })).toEqual([]);
    expect(craftFindings({ ...base, placements: ["youtube"], productAtMs: 12_000 })[0]).toMatchObject({ id: "hook-product", title: "The product first appears at 0:12" });
    expect(ids({ placements: ["youtube"], productAtMs: null })).toContain("hook-product");
    expect(ids({ productKnown: false, productAtMs: null })).not.toContain("hook-product");
  });

  it("asks for captions where feeds play muted, sound where TikTok expects it, and a next step", () => {
    expect(ids({ placements: ["feed"], spokenLines: 6, onScreen: [] })).toEqual(expect.arrayContaining(["sound-captions", "next-step"]));
    expect(ids({ hasSound: false })).toContain("sound-tiktok");
    expect(ids({ placements: ["youtube"], hasSound: false })).not.toContain("sound-tiktok");
  });
});
