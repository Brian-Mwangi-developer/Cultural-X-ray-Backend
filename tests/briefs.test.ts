import { describe, expect, it } from "vitest";
import { briefPrompt, briefSchema, channelRules, practiceBrief, toLines } from "@/modules/briefs/brief.write";
import type { PlayContext } from "@/modules/plays/plays";

const ctx: PlayContext = {
  brand: "GAIL's",
  market: "GB",
  rivals: ["Le Pain Quotidien"],
  readings: [],
  items: [
    { ref: "i1", entityId: "e1", name: "Yotam Ottolenghi", kind: "PERSON", label: "YOURS", rival: null, lean: 1, rank: 1, detail: null },
    { ref: "i2", entityId: "e2", name: "Home Cooking", kind: "PODCAST", label: "CONTESTED", rival: "Le Pain Quotidien", lean: 0.7, rank: 2, detail: null },
    { ref: "i3", entityId: "e3", name: "The goop Podcast", kind: "PODCAST", label: "THEIRS", rival: "Le Pain Quotidien", lean: 0.2, rank: 4, detail: null },
  ],
};
const input = { occasion: "Autumn bake", placements: ["tiktok", "feed"], notes: [], audience: null, adRead: null };

describe("briefs: written from the map, kept honest by code", () => {
  it("drops cited lines that point at nothing, or at the wrong side of the map", () => {
    const answer = briefSchema.parse({
      title: "Autumn bake",
      ask: [{ text: "Own the autumn bake." }],
      audience: [{ text: "Ottolenghi fans", refs: ["i1"] }, { text: "Made-up people", refs: ["i99"] }],
      insight: [{ text: "Uses a rival's item", refs: ["i3"] }],
      proposition: [{ text: "Baked this morning." }],
      tone: ["warm"],
      showUp: [{ text: "Home Cooking", refs: ["i2"] }],
      avoid: [{ text: "goop", refs: ["i3"] }, { text: "Ottolenghi isn't theirs", refs: ["i1"] }],
      mandatories: [],
    });
    const { lines } = toLines(answer, ctx, input.placements);
    const texts = (s: string) => lines.filter((l) => l.section === s).map((l) => l.text);
    expect(texts("audience")).toEqual(["Ottolenghi fans"]);
    expect(texts("insight")).toEqual([]);
    expect(texts("showUp")).toEqual(["Home Cooking"]);
    expect(texts("avoid")).toEqual(["goop"]);
    expect(texts("proposition")).toEqual(["Baked this morning.", "Tone: warm."]);
    expect(lines.find((l) => l.section === "showUp")!.refs[0]).toMatchObject({ entityId: "e2", label: "CONTESTED", rival: "Le Pain Quotidien" });
  });

  it("adds the channel rules to the must-haves", () => {
    expect(channelRules("GAIL's", ["tiktok", "feed"]).join(" ")).toMatch(/9:16.*TikTok.*sound off.*sound on TikTok/s);
    const { lines } = toLines(practiceBrief(ctx, input), ctx, input.placements);
    expect(lines.filter((l) => l.section === "mandatories").length).toBeGreaterThanOrEqual(4);
  });

  it("practice answers pass the schema, and the prompt keeps the rules", () => {
    expect(briefSchema.safeParse(practiceBrief(ctx, input)).success).toBe(true);
    const p = briefPrompt(ctx, input);
    expect(p).toContain("i1 · Yotam Ottolenghi");
    expect(p).toMatch(/Never describe anyone's age, body, face or looks/);
    expect(p).not.toMatch(/affinity score/i);
  });
});
