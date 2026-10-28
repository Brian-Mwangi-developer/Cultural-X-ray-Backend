import { tool } from "ai";
import { z } from "zod";
import { audienceOf, latestMap } from "@/modules/maps/map.service";
import { CARDS, cardOfPart, JOURNEY_IDS } from "@/modules/guide/guide.cards";
import { guideOf } from "@/modules/guide/guide.service";
import { FACT_MAX, remember } from "@/modules/guide/guide.memory";
import { usageOf } from "@/modules/usage/usage.service";

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

/** What the person's browser says is on screen as they ask: the page and the guide parts on it. */
export type Screen = { page: string; parts: string[] };

const PAGES = Object.keys(CARDS) as [string, ...string[]];
const PART_IDS = Object.values(CARDS).flatMap((c) => c.parts.map((p) => p.id)) as [string, ...string[]];

/**
 * The guide's hands (plan-guide.md §6). The browser carries them out when the answer arrives (opens
 * the page, rings the part, runs the walk-through); here each one is checked against what the person
 * actually has on screen, so the model learns the truth instead of assuming. None of them changes
 * anything: the person presses.
 */
export function guideTools(ctx: { userId: string; workspaceId: string; screen: Screen | null }) {
  const here = ctx.screen?.page ?? null;
  const onScreen = new Set(ctx.screen?.parts ?? []);
  return {
    status: tool({
      description: "What is true in this workspace right now: the getting-started steps and which are done (and by whom), the next step, and Qloo queries left this month. Call it before telling the person what to do next or whether something has finished.",
      inputSchema: z.object({}),
      execute: async () => {
        const [g, u] = await Promise.all([guideOf(ctx.userId, { id: ctx.workspaceId, kind: "WORKSPACE" }), usageOf(ctx.workspaceId)]);
        return {
          steps: g.steps.map((s) => ({ step: s.title, done: s.done, ...(s.by ? { doneBy: s.by } : {}), ...(s.busy ? { underWay: true } : {}) })),
          next: g.next?.title ?? "Everything in getting started is done.",
          qlooQueries: `${u.used} of ${u.allowance} used this month`,
          onScreenNow: here === null ? "unknown" : here || "overview",
        };
      },
    }),
    about: tool({
      description: "Read the card for one page of the product: what it's for, its parts (by name), how to use it, and what people get wrong. Use it when the person asks how something works or where to find it.",
      inputSchema: z.object({ page: z.enum(PAGES) }),
      execute: async ({ page }) => CARDS[page],
    }),
    go_to: tool({
      description: "Open a page for the person (their browser navigates). Use when they ask to see or go somewhere. Only pages with a path.",
      inputSchema: z.object({ page: z.enum(PAGES) }),
      execute: async ({ page }) => {
        const card = CARDS[page]!;
        if (card.path === null) return { opened: false, note: `${card.title} has no single address; tell the person how to reach it instead.` };
        return { opened: true, path: card.path };
      },
    }),
    point_at: tool({
      description: "Ring one part of a page and show a short line beside it, opening its page first if needed. Use this to show where something is instead of describing menus. One part per call; keep `say` to one plain sentence.",
      inputSchema: z.object({ part: z.enum(PART_IDS), say: z.string().min(4).max(180) }),
      execute: async ({ part }) => {
        const [page, card] = cardOfPart(part)!;
        if (onScreen.has(part)) return { pointed: true };
        if (card.path !== null && here !== card.path) return { pointed: true, note: `Opening ${card.title} first.` };
        return { pointed: false, note: `That part isn't on the person's screen right now${page === "ad-read" ? " (it's on an ad's own page)" : " (the page may still be loading or have no data yet)"}. Say where it will be instead.` };
      },
    }),
    remember: tool({
      description:
        "Keep one short, lasting fact the person told you about their business, plans or how they like answers (e.g. 'Opening a second shop in Leeds in March', 'Prefers short answers'). The person sees every note and can delete it. Never keep anything about anyone's health, looks, age, beliefs or other private life, nor passwords or numbers they wouldn't want stored. Don't keep what the map already says.",
      inputSchema: z.object({ fact: z.string().min(4).max(FACT_MAX) }),
      execute: async ({ fact }) => remember(ctx.userId, ctx.workspaceId, fact),
    }),
    walk_through: tool({
      description: "Start a short step-by-step walk-through of a page in the person's browser: map (reading the Culture Map), plays, ad (checking an ad), ad-read (reading an ad check). Best for 'how do I use this' questions.",
      inputSchema: z.object({ journey: z.enum(JOURNEY_IDS) }),
      execute: async ({ journey }) => ({ started: journey !== "ad-read" || here?.startsWith("ad-check/") === true, ...(journey === "ad-read" && !here?.startsWith("ad-check/") ? { note: "Only works on an ad's own page; ask them to open one first." } : {}) }),
    }),
  };
}

export function askTools(workspaceId: string, guide?: { userId: string; screen: Screen | null }) {
  return {
    ...(guide ? guideTools({ userId: guide.userId, workspaceId, screen: guide.screen }) : {}),
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
