import { tool } from "ai";
import { z } from "zod";
import { audienceOf, latestMap } from "@/modules/maps/map.service";

/**
 * What Ask X-Ray can do. Two read tools give the model the workspace's map in plain words
 * (never Qloo's scores), and three illustration tools draw in the conversation: the model's
 * input is the picture, validated here and rendered by the web. Every picture says how to read it.
 */

const KINDS = ["PODCAST", "MOVIE", "TV_SHOW", "DESTINATION", "PERSON", "ARTIST", "BRAND", "BOOK"] as const;

const leanWords = (lean: number | null, rival: string | null) =>
  lean == null ? null : lean >= 0.6 ? "leans your way" : lean <= 0.4 ? `leans to ${rival ?? "them"}` : "about even";

const strength = (v: number | null | undefined) =>
  v == null ? "not enough data" : v >= 0.9 ? "very strong" : v >= 0.8 ? "strong" : v >= 0.7 ? "good" : v >= 0.6 ? "some" : "weak";

/** The map as the model reads it: readings, then items with who holds them. */
export async function mapForModel(workspaceId: string, kinds?: string[]) {
  const map = await latestMap(workspaceId, 12);
  if (!map) return { status: "none", note: "This workspace has no Culture Map yet. Suggest building one from the overview." };
  if (map.status !== "READY") return { status: map.status.toLowerCase(), note: `The map is still building (${map.categoriesDone} of ${map.categoriesTotal} categories). Answer from what is ready, and say so.` };
  const own = map.subjects.filter((s) => s.role !== "RIVAL").map((s) => s.name);
  return {
    status: "ready",
    built: map.builtAt,
    market: map.market === "GB" ? "UK" : "US",
    readFor: own,
    rivals: map.subjects.filter((s) => s.role === "RIVAL").map((s) => s.name),
    categories: map.categories
      .filter((c) => !kinds?.length || kinds.includes(c.kind))
      .map((c) => ({
        category: c.label,
        reading: c.reading,
        counts: { onlyYours: c.counts.yours, shared: c.counts.contested, onlyRivals: c.counts.theirs },
        items: c.items.map((i, n) => ({
          name: i.name,
          position: n + 1,
          holder: i.label === "YOURS" ? "only yours" : i.label === "CONTESTED" ? `shared with ${i.rival}` : `only ${i.rival}`,
          lean: leanWords(i.lean, i.rival),
          detail: i.detail,
        })),
      })),
  };
}

/** Who each brand reaches and where its customers go, in words. */
export async function audienceForModel(workspaceId: string) {
  const a = await audienceOf(workspaceId);
  if (!a) return { status: "none", note: "No ready map yet, so there's no audience to read." };
  return {
    status: "ready",
    brands: a.sides.map((s) => (s.key === "you" && s.readThrough ? "your customers (read through the brands they also buy)" : s.name)),
    groups: a.hasAudience
      ? a.segments.map((seg) => ({
          group: seg.label,
          ...Object.fromEntries(a.sides.map((s) => [s.key === "you" ? "you" : s.name, `${strength(seg.cells[s.key]?.value)}${seg.cells[s.key]?.lowConfidence ? " (thin data)" : ""}`])),
        }))
      : "This map was built before ages and genders were read; suggest a rebuild.",
    places: a.places
      .filter((p) => p.ranks.you)
      .sort((x, y) => x.ranks.you! - y.ranks.you!)
      .slice(0, 12)
      .map((p) => ({ place: p.name, region: p.detail, yourPosition: p.ranks.you, holder: p.label === "YOURS" ? "only yours" : `shared with ${p.rival}` })),
    rivalsOnlyPlaces: a.places.filter((p) => p.label === "THEIRS").slice(0, 6).map((p) => ({ place: p.name, of: p.rival })),
  };
}

/* ------------------------------------------------------------- illustrations */

const howToRead = z.string().min(10).max(220).describe("One or two plain sentences under the picture: what it shows and how to read it. No jargon, no scores.");

export const rankingSchema = z.object({
  title: z.string().max(80),
  items: z
    .array(
      z.object({
        name: z.string().max(80),
        position: z.number().int().min(1).max(50).describe("Where it sits on your customers' list, 1 = top"),
        holder: z.enum(["yours", "shared", "theirs"]).describe("Only yours, shared with a rival, or only a rival's"),
        note: z.string().max(80).optional().describe("A few plain words, e.g. 'shared with Ben & Jerry's, leans your way'"),
      }),
    )
    .min(2)
    .max(10),
  howToRead,
});

export const chartSchema = z.object({
  title: z.string().max(80),
  type: z.enum(["bar", "line"]),
  labels: z.array(z.string().max(40)).min(2).max(12).describe("One label per bar or point, left to right"),
  series: z
    .array(z.object({ name: z.string().max(40), values: z.array(z.number()).min(2).max(12) }))
    .min(1)
    .max(3)
    .describe("Counts or positions only. Never Qloo affinity scores."),
  yLabel: z.string().max(40).describe("What the numbers count, e.g. 'Podcasts in the top 20'"),
  howToRead,
});

export const tableSchema = z.object({
  title: z.string().max(80),
  columns: z.array(z.string().max(40)).min(2).max(5),
  rows: z.array(z.array(z.string().max(80))).min(1).max(12),
  howToRead,
});

const shown = async () => ({ shown: true });

export function askTools(workspaceId: string) {
  return {
    read_map: tool({
      description:
        "Read this workspace's Culture Map: per category (podcasts, films, TV, places, creators, artists, brands, books) what its customers like, in order, and whether each item is only theirs, shared with a rival, or only a rival's. Call it before answering anything about the brand's customers or rivals.",
      inputSchema: z.object({ categories: z.array(z.enum(KINDS)).optional().describe("Limit to these categories; leave out for all") }),
      execute: async ({ categories }) => mapForModel(workspaceId, categories),
    }),
    read_audience: tool({
      description: "Read who each brand reaches (age groups, women and men, in words) and the places its customers go, with positions. Use for questions about who the customers are or where they go.",
      inputSchema: z.object({}),
      execute: async () => audienceForModel(workspaceId),
    }),
    show_ranking: tool({
      description: "Draw a ranked list in the conversation: items in order with who holds them (yours, shared, theirs). Best for 'what should we sponsor / where should we go' answers.",
      inputSchema: rankingSchema,
      execute: shown,
    }),
    show_chart: tool({
      description: "Draw a simple bar or line chart in the conversation, to compare counts (e.g. how many of each rival's top 20 podcasts are shared with you). Only plot counts or positions taken from the tools. Never plot scores.",
      inputSchema: chartSchema,
      execute: shown,
    }),
    show_table: tool({
      description: "Show a small table in the conversation, e.g. groups by brand with words like 'strong' or 'weak'. Plain words in cells, no scores.",
      inputSchema: tableSchema,
      execute: shown,
    }),
  };
}

export type AskTools = ReturnType<typeof askTools>;
