import { describe, expect, it } from "vitest";
import { nextStep, stepsFor, type WorkspaceFacts } from "@/modules/guide/guide.steps";
import { MARK_KEY } from "@/modules/guide/guide.service";

const fresh: WorkspaceFacts = { kind: "WORKSPACE", mapReady: false, mapBuilding: false, mapBy: null, seenMap: false, seenPlays: false, adRead: false, adBy: null, teammates: false };

describe("guide: steps ticked by real work", () => {
  it("starts with the map, and nothing that reads it comes first while it isn't ready", () => {
    expect(nextStep(stepsFor(fresh), "ads")?.id).toBe("map");
  });

  it("puts the goal from the welcome room first once the map is ready", () => {
    const ready = { ...fresh, mapReady: true };
    expect(nextStep(stepsFor(ready), "ads")?.id).toBe("ad");
    expect(nextStep(stepsFor(ready), "creators")?.id).toBe("plays");
    expect(nextStep(stepsFor(ready), null)?.id).toBe("read-map");
  });

  it("moves past a goal that's already done, and says who did steps for a brand its agency runs", () => {
    const steps = stepsFor({ ...fresh, mapReady: true, mapBy: "Harbor & Pine", adRead: true, adBy: "Harbor & Pine" });
    expect(nextStep(steps, "ads")?.id).toBe("read-map");
    expect(steps.find((s) => s.id === "map")).toMatchObject({ done: true, by: "Harbor & Pine" });
  });

  it("is done when every step is", () => {
    expect(nextStep(stepsFor({ ...fresh, mapReady: true, seenMap: true, seenPlays: true, adRead: true, teammates: true }), null)).toBeNull();
  });

  it("gives agencies their own steps", () => {
    const steps = stepsFor({ kind: "AGENCY", clients: true, seenClientMap: false, teammates: false, access: false });
    expect(steps.map((s) => s.id)).toEqual(["client", "client-map", "team", "access"]);
    expect(nextStep(steps, "team")?.id).toBe("team");
  });

  it("only takes known kinds of mark", () => {
    expect(["seen:map", "tour:plays", "visit", "bar:folded"].every((k) => MARK_KEY.test(k))).toBe(true);
    expect(["welcome", "goal:ads", "seen:Map", "anything"].some((k) => MARK_KEY.test(k))).toBe(false);
  });
});

describe("guide: what Ask X-Ray remembers", () => {
  it("keeps one plain line per note", async () => {
    const { tidy, FACT_MAX } = await import("@/modules/guide/guide.memory");
    expect(tidy("  Opening a second shop\n in Leeds in March.  ")).toBe("Opening a second shop in Leeds in March");
    expect(tidy("x".repeat(400))).toHaveLength(FACT_MAX);
  });

  it("knows the same note said slightly differently, and not a different one", async () => {
    const { same } = await import("@/modules/guide/guide.memory");
    expect(same("Opening a new shop in Leeds in May", "Opening a shop in Leeds in May")).toBe(true);
    expect(same("Opening a shop in Leeds in May", "Opening a shop in Manchester in May")).toBe(false);
  });
});
