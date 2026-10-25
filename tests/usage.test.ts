import { describe, expect, it } from "vitest";
import { costMicros, dollars, rateFor } from "@/modules/usage/pricing";

const nov2026 = new Date("2026-11-15T12:00:00Z");
const feb2027 = new Date("2027-02-01T12:00:00Z");

describe("usage: what a call costs", () => {
  it("prices Gemini 3.8 Flash at the promotion until the end of 2026, then the standard price", () => {
    expect(rateFor("gemini-3.8-flash", nov2026)).toMatchObject({ input: 0.75, output: 3.75 });
    expect(rateFor("gemini-3.8-flash", feb2027)).toMatchObject({ input: 1.5, output: 7.5 });
  });

  it("matches the measured Jude's ad check (22,510 in, 3,578 out: $0.030 today)", () => {
    const micros = costMicros("gemini-3.8-flash", { inputTokens: 22_510, outputTokens: 3_578 }, { at: nov2026 })!;
    expect(micros).toBe(Math.round(22_510 * 0.75 + 3_578 * 3.75));
    expect(dollars(micros)).toBe("$0.030");
  });

  it("bills thinking as output and cached input at the cached rate", () => {
    const plain = costMicros("gemini-3.5-flash-lite", { inputTokens: 1_000, outputTokens: 100 }, { at: nov2026 })!;
    const thinking = costMicros("gemini-3.5-flash-lite", { inputTokens: 1_000, outputTokens: 100, thoughtTokens: 100 }, { at: nov2026 })!;
    expect(thinking - plain).toBe(100 * 2.5);
    const cached = costMicros("gemini-3.5-flash-lite", { inputTokens: 1_000, outputTokens: 0, cachedTokens: 1_000 }, { at: nov2026 })!;
    expect(cached).toBe(Math.round(1_000 * 0.03));
  });

  it("adds 10% outside the global region", () => {
    const g = costMicros("gemini-3.8-flash", { inputTokens: 10_000, outputTokens: 0 }, { at: nov2026 })!;
    const r = costMicros("gemini-3.8-flash", { inputTokens: 10_000, outputTokens: 0 }, { at: nov2026, location: "europe-west2" })!;
    expect(r).toBe(Math.round(g * 1.1));
  });

  it("returns null for a model with no price rather than guessing", () => {
    expect(costMicros("gemini-9-unknown", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});
