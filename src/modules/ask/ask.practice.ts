import type { LanguageModelV4, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";

/**
 * Practice mode (ASK_PRACTICE=true): a stand-in model that costs nothing. It still goes through
 * the real tools, so the map is really read and the picture is really drawn from it; only the
 * wording is scripted. Used to build and test the chat without spending model credit.
 */

type ToolResult = { toolName: string; value: unknown };

function lastUserText(prompt: LanguageModelV4Prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role === "user") return m.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
  }
  return "";
}

/** Tool results since the last user message, oldest first. */
function resultsSinceUser(prompt: LanguageModelV4Prompt): ToolResult[] {
  const out: ToolResult[] = [];
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role === "user") break;
    if (m.role === "tool")
      for (const c of m.content)
        if (c.type === "tool-result") out.unshift({ toolName: c.toolName, value: c.output.type === "json" ? c.output.value : c.output.type === "text" ? c.output.value : null });
  }
  return out;
}

const CATEGORY_WORDS: [RegExp, string][] = [
  [/film|movie|cinema/i, "Films"],
  [/\btv\b|show|series/i, "TV"],
  [/creator|influencer|people|who to work/i, "Creators"],
  [/artist|music|song|band/i, "Artists"],
  [/brand|partner|collab/i, "Brands"],
  [/book|read/i, "Books"],
];
const wantsAudience = (q: string) => /where|place|pop-?up|visit|who (are|is)|age|women|men|older|younger|missing/i.test(q);

type MapItem = { name: string; position: number; holder: string; lean: string | null };
type MapResult = { status: string; note?: string; categories?: { category: string; reading: string | null; items: MapItem[] }[] };
type AudienceResult = { status: string; note?: string; brands?: string[]; groups?: Record<string, string>[] | string; places?: { place: string; yourPosition: number; holder: string }[] };

function answerFromMap(q: string, map: MapResult): { text: string; picture?: { toolName: string; input: unknown } } {
  if (map.status !== "ready") return { text: map.note ?? "Your map isn't ready yet." };
  const wanted = CATEGORY_WORDS.find(([re]) => re.test(q))?.[1] ?? "Podcasts";
  const cat = map.categories?.find((c) => c.category === wanted) ?? map.categories?.[0];
  if (!cat || !cat.items.length) return { text: `Nothing in ${wanted.toLowerCase()} stands out for your customers yet.` };
  const mine = cat.items.filter((i) => !i.holder.startsWith("only ") || i.holder === "only yours");
  const only = mine.find((i) => i.holder === "only yours");
  const shared = mine.find((i) => i.holder.startsWith("shared"));
  const lines = [
    only
      ? `Start with ${only.name}. It's ${only.position === 1 ? "your customers' top pick" : `number ${only.position} for your customers`} in ${cat.category.toLowerCase()}, and none of your rivals' customers have it, so you'd have it to yourself.`
      : `Your customers' top pick in ${cat.category.toLowerCase()} is ${mine[0]?.name}.`,
    shared ? `${shared.name} is also high on their list, but it's ${shared.holder}${shared.lean ? ` and ${shared.lean}` : ""}. Keep it for when you want to take ground from them.` : "",
  ].filter(Boolean);
  const holder = (h: string) => (h === "only yours" ? "yours" : h.startsWith("shared") ? "shared" : "theirs");
  return {
    text: lines.join("\n\n"),
    picture: {
      toolName: "show_ranking",
      input: {
        title: `Your customers' top ${cat.category.toLowerCase()}`,
        items: mine.slice(0, 5).map((i) => ({ name: i.name, position: i.position, holder: holder(i.holder), note: i.holder === "only yours" ? "Only yours" : `${i.holder[0]!.toUpperCase()}${i.holder.slice(1)}${i.lean ? `, ${i.lean}` : ""}` })),
        howToRead: "Higher on the list means more of your customers pick it. Orange is only yours; grey is shared with a rival.",
      },
    },
  };
}

function answerFromAudience(a: AudienceResult): { text: string; picture?: { toolName: string; input: unknown } } {
  if (a.status !== "ready") return { text: a.note ?? "There's no audience to read yet." };
  const places = (a.places ?? []).slice(0, 3).map((p) => p.place);
  const groups = Array.isArray(a.groups) ? a.groups : [];
  const strong = groups.filter((g) => /^very strong|^strong/.test(String(g.you))).map((g) => String(g.group).toLowerCase()).slice(0, 2);
  const text = [
    strong.length ? `Your strongest groups are ${strong.join(" and ")}.` : "",
    places.length ? `Your customers go to ${places.slice(0, -1).join(", ")}${places.length > 1 ? " and " : ""}${places.at(-1)}, so that's where a pop-up or a local push starts.` : "",
  ].filter(Boolean).join(" ");
  const brands = a.brands ?? [];
  return {
    text: text || "Qloo doesn't know enough about who your customers are yet.",
    picture: groups.length
      ? {
          toolName: "show_table",
          input: {
            title: "Who each brand reaches",
            columns: ["Group", ...brands.map((b) => (b.startsWith("your customers") ? "You" : b))].slice(0, 5),
            rows: groups.slice(0, 8).map((g) => [String(g.group), ...Object.entries(g).filter(([k]) => k !== "group").map(([, v]) => String(v))].slice(0, 5)),
            howToRead: "Each cell says how much that group goes for the brand. Thin data means Qloo has little to go on, so treat it as a hint.",
          },
        }
      : undefined,
  };
}

function* words(text: string) {
  // Keep leading whitespace (paragraph breaks) with the first word.
  for (const piece of text.match(/\s*\S+\s*/g) ?? []) yield piece;
}

/** Exported for tests: what practice mode streams for a conversation so far. */
export function practiceParts(prompt: LanguageModelV4Prompt): LanguageModelV4StreamPart[] {
  const q = lastUserText(prompt);
  const results = resultsSinceUser(prompt);
  const finish = (reason: "stop" | "tool-calls"): LanguageModelV4StreamPart => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
  });
  const call = (toolName: string, input: unknown): LanguageModelV4StreamPart[] => [{ type: "tool-call", toolCallId: `practice-${toolName}-${Date.now()}`, toolName, input: JSON.stringify(input) }, finish("tool-calls")];
  const say = (text: string): LanguageModelV4StreamPart[] => [{ type: "text-start", id: "t" }, ...[...words(text)].map((delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t", delta })), { type: "text-end", id: "t" }];

  // 1. Read what the question needs.
  if (!results.length) return call(wantsAudience(q) ? "read_audience" : "read_map", {});
  const last = results.at(-1)!;
  // 3. After the picture: one line offering the next step.
  if (last.toolName.startsWith("show_")) return [...say("\n\nWant me to turn this into a short brief for your team?"), finish("stop")];
  // 2. Answer in words, then draw.
  const answer = last.toolName === "read_audience" ? answerFromAudience(last.value as AudienceResult) : answerFromMap(q, last.value as MapResult);
  return [...say(answer.text), ...(answer.picture ? call(answer.picture.toolName, answer.picture.input) : [finish("stop")])];
}

export const practiceModel: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "practice",
  modelId: "practice",
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("practice mode only streams");
  },
  doStream: async (options) => ({
    stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] } as LanguageModelV4StreamPart, ...practiceParts(options.prompt)], initialDelayInMs: 250, chunkDelayInMs: 18 }),
  }),
};
