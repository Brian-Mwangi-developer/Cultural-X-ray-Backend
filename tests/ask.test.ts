import { describe, expect, it } from "vitest";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { practiceParts } from "@/modules/ask/ask.practice";
import { chartSchema, rankingSchema, tableSchema } from "@/modules/ask/ask.tools";

// Practice mode must exercise the real tool path, so these check the turns it takes.
const ask = (text: string): LanguageModelV4Prompt => [{ role: "user", content: [{ type: "text", text }] }];
const withResult = (prompt: LanguageModelV4Prompt, toolName: string, value: unknown): LanguageModelV4Prompt => [
  ...prompt,
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName, input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName, output: { type: "json", value: value as never } }] },
];
const calls = (parts: ReturnType<typeof practiceParts>) => parts.filter((p) => p.type === "tool-call") as { toolName: string; input: string }[];
const text = (parts: ReturnType<typeof practiceParts>) => parts.map((p) => (p.type === "text-delta" ? p.delta : "")).join("");

const MAP = {
  status: "ready",
  categories: [
    {
      category: "Podcasts",
      reading: "",
      items: [
        { name: "My Favorite Murder", position: 1, holder: "shared with Ben & Jerry's", lean: "leans your way" },
        { name: "RedHanded", position: 2, holder: "only yours", lean: null },
        { name: "Getting Curious", position: 3, holder: "only Häagen-Dazs", lean: null },
      ],
    },
  ],
};

describe("ask: practice mode", () => {
  it("reads the map first, or the audience for who-and-where questions", () => {
    expect(calls(practiceParts(ask("Which podcast should we sponsor first?")))[0]?.toolName).toBe("read_map");
    expect(calls(practiceParts(ask("Where should our pop-up go?")))[0]?.toolName).toBe("read_audience");
  });

  it("answers from what the map returned, in words, then draws a valid ranking without rivals' items", () => {
    const parts = practiceParts(withResult(ask("Which podcast should we sponsor first?"), "read_map", MAP));
    expect(text(parts)).toContain("Start with RedHanded");
    expect(text(parts)).not.toMatch(/\d\.\d/);
    const ranking = calls(parts).find((c) => c.toolName === "show_ranking")!;
    const spec = rankingSchema.parse(JSON.parse(ranking.input));
    expect(spec.items.map((i) => i.name)).toEqual(["My Favorite Murder", "RedHanded"]);
  });

  it("says so plainly when there is no map", () => {
    const parts = practiceParts(withResult(ask("Which podcast?"), "read_map", { status: "none", note: "This workspace has no Culture Map yet." }));
    expect(text(parts)).toContain("no Culture Map yet");
    expect(calls(parts)).toHaveLength(0);
  });
});

describe("ask: pictures", () => {
  it("require a plain how-to-read line", () => {
    expect(rankingSchema.safeParse({ title: "x", items: [{ name: "a", position: 1, holder: "yours" }, { name: "b", position: 2, holder: "shared" }] }).success).toBe(false);
    expect(tableSchema.safeParse({ title: "x", columns: ["a", "b"], rows: [["1", "2"]], howToRead: "Each row is a group." }).success).toBe(true);
  });

  it("keep charts small", () => {
    const series = [{ name: "a", values: Array(13).fill(1) }];
    expect(chartSchema.safeParse({ title: "x", type: "bar", labels: Array(13).fill("l"), series, yLabel: "y", howToRead: "Taller bars mean more." }).success).toBe(false);
  });
});
