import { describe, expect, it } from "vitest";
import { searchTowns } from "@/modules/lookup/towns";

describe("onboarding: town search without Qloo", () => {
  it("finds the towns that timed out on Qloo, in the right market, with a location", () => {
    expect(searchTowns("Whitby", "GB")[0]).toMatchObject({ name: "Whitby", detail: "Whitby, England, United Kingdom" });
    expect(searchTowns("harrog", "GB")[0]?.name).toBe("Harrogate");
    expect(searchTowns("Truro", "GB")[0]?.location.lat).toBeCloseTo(50.26, 1);
    expect(searchTowns("Austin", "US")[0]).toMatchObject({ name: "Austin", detail: "Austin, Texas, United States" });
  });

  it("puts the exact name first, then bigger places, and ignores case and accents", () => {
    expect(searchTowns("york", "GB")[0]?.name).toBe("York");
    expect(searchTowns("BRIGHTON", "GB")[0]?.name).toBe("Brighton");
    expect(searchTowns("w", "GB")).toEqual([]);
  });
});
