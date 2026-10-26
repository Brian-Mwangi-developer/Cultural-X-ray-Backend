import { z } from "zod";
import type { PlayKind } from "@/generated/prisma/client";
import { categoryOf, type Kind, type Label, type Market } from "@/modules/maps/map.shape";

/**
 * Plays: moves a brand can make this month, written from its Culture Map. Gemini (smart, text only)
 * proposes them from the map's items; code keeps only plays whose items are on the map and on your
 * side of it, takes each play's kind and lean from the map rather than from Gemini, and attaches the
 * words each source's tooltip shows. Same pattern as the re-cuts: Gemini proposes, code checks.
 */

export const MAX_PLAYS = 6;
const PER_CATEGORY = 2;

/** Which kind of play an item makes. Books inform the plays but don't make one. */
export const PLAY_OF: Record<Kind, PlayKind | null> = {
  PERSON: "CREATOR", PODCAST: "PODCAST", TV_SHOW: "SHOW", MOVIE: "SHOW", ARTIST: "SOUND", DESTINATION: "PLACE", BRAND: "PARTNER", BOOK: null,
};

/** One map item as the prompt and the checks see it. `ref` is how Gemini names it ("i12"). */
export type PlayItem = { ref: string; entityId: string; name: string; kind: Kind; label: Label; rival: string | null; lean: number | null; rank: number; detail: string | null };
export type PlayContext = { brand: string; market: Market; rivals: string[]; readings: { kind: Kind; text: string }[]; items: PlayItem[] };

const words = (max: number) => z.string().trim().min(1).max(max);

export const playsSchema = z.object({
  plays: z
    .array(
      z.object({
        /** The items it rests on, by ref, from one category; the first is the one to act on. */
        items: z.array(z.string()).min(1).max(4),
        /** An instruction: "Work with Nadiya Hussain", "Sponsor The Rest Is History". */
        title: words(80),
        /** Two plain sentences: what to do and how. */
        body: words(320),
        /** One sentence: why the map backs it, naming whose customers. */
        why: words(180),
        /** What to brief a partner: up to three short lines. */
        brief: z.array(words(140)).max(3),
      }),
    )
    .max(8),
});
export type PlaysAnswer = z.infer<typeof playsSchema>;

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};
/** "Ben & Jerry's" → "Ben & Jerry's", "Häagen-Dazs" → "Häagen-Dazs’", "Jude's" stays. */
export const possessive = (name: string) => (/['’]s$/i.test(name) ? name : /s$/i.test(name) ? `${name}’` : `${name}’s`);

/** The words for an item's tooltip. No scores: where it ranks for your customers and whose it is. */
export function proofOf(item: PlayItem, rivals: string[]): string {
  const c = categoryOf(item.kind);
  const list = `the ${c?.noun ?? "things"} your customers ${c?.verb ?? "like"} on Qloo`;
  if (item.label === "YOURS") {
    const others = rivals.length ? rivals.map(possessive).join(" or ") + " customers" : "your rivals’ customers";
    return `${item.name} is ${ordinal(item.rank + 1)} among ${list}, and ${others} don’t rank it.`;
  }
  if (item.label === "CONTESTED") {
    const lean = item.lean == null ? "" : item.lean >= 0.55 ? ", and it sits higher on your customers’ list" : item.lean <= 0.45 ? ", and it sits higher on theirs" : "";
    return `${item.name} is ${ordinal(item.rank + 1)} among ${list}. ${item.rival ? possessive(item.rival) : "A rival’s"} customers rank it too${lean}.`;
  }
  return `${item.name} belongs to ${item.rival ? possessive(item.rival) : "a rival’s"} customers, not yours.`;
}

const LABEL_WORDS: Record<Label, string> = { YOURS: "only yours", CONTESTED: "shared", THEIRS: "theirs" };

export function playsPrompt(c: PlayContext) {
  const byKind = new Map<Kind, PlayItem[]>();
  for (const i of c.items) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  const sections = [...byKind.entries()].map(([kind, items]) => {
    const cat = categoryOf(kind);
    const reading = c.readings.find((r) => r.kind === kind)?.text;
    const lines = items.map((i) => {
      const who = i.label === "CONTESTED" ? `shared with ${i.rival ?? "a rival"}${i.lean != null && i.lean >= 0.55 ? ", leans your way" : ""}` : i.label === "THEIRS" ? `only ${i.rival ?? "a rival"}'s customers` : LABEL_WORDS.YOURS;
      return `${i.label === "THEIRS" ? "-" : i.ref} · ${i.name}${i.detail ? ` (${i.detail})` : ""} · ${who}`;
    });
    return [`${cat?.label.toUpperCase() ?? kind} (what customers ${cat?.verb ?? "like"})${reading ? ` — ${reading}` : ""}`, ...lines].join("\n");
  });
  return [
    `You are a brand strategist for ${c.brand}, in the ${c.market === "GB" ? "UK" : "US"} market. Its rivals are ${c.rivals.join(" and ") || "unknown"}.`,
    `Below is ${c.brand}'s Culture Map from Qloo: what its customers listen to, watch, follow, visit and buy, in order (first is strongest), and whether each is only theirs, shared with a rival, or only a rival's.`,
    "",
    ...sections.flatMap((s) => [s, ""]),
    `Write up to ${MAX_PLAYS} plays: concrete moves ${c.brand} could make this month to reach its customers where rivals aren't.`,
    "Rules:",
    "- Each play rests on 1 to 4 items from ONE section, named by their refs (i1, i2…). The first item is the one to act on. Items marked \"-\" are rivals' ground: never build a play on them.",
    "- Prefer items that are only yours; a shared item is worth it when it leans your way.",
    `- At most ${PER_CATEGORY} plays per section, and cover different sections.`,
    "- title: an instruction naming the item (\"Work with …\", \"Sponsor …\", \"Show up around …\", \"Pop up in …\", \"Sound like …\", \"Team up with …\").",
    "- why: one sentence on why the map backs it, naming whose customers (no numbers, no scores, no percentages).",
    "- body: two plain sentences: what to do and how.",
    "- brief: up to three short lines to brief a partner (what to make, what to avoid because it's a rival's ground).",
    "- Claim only what the map shows: who ranks an item, and whether rivals' customers do. Never claim anything about ad spend, sales, audience sizes or what rivals are doing.",
    "- About people: name them only as listed; never comment on anyone's age, body, face or looks.",
    "Answer only with JSON that matches the schema.",
  ].join("\n");
}

const TITLE: Record<PlayKind, (name: string) => string> = {
  CREATOR: (n) => `Work with ${n}`, PODCAST: (n) => `Sponsor ${n}`, SHOW: (n) => `Show up around ${n}`, PLACE: (n) => `Pop up in ${n}`,
  SOUND: (n) => `Sound like ${n}`, PARTNER: (n) => `Team up with ${n}`, ARTIST: (n) => `Sound like ${n}`, AESTHETIC: (n) => `Look like ${n}`, PRICE: (n) => n,
};

/** Practice mode: one play per category from its strongest item that's yours. Schema-valid. */
export function practicePlays(c: PlayContext): PlaysAnswer {
  const seen = new Set<PlayKind>();
  const plays: PlaysAnswer["plays"] = [];
  for (const i of c.items) {
    const kind = PLAY_OF[i.kind];
    if (!kind || i.label !== "YOURS" || seen.has(kind) || plays.length >= MAX_PLAYS) continue;
    seen.add(kind);
    const noun = categoryOf(i.kind)?.noun ?? "things";
    plays.push({
      items: [i.ref],
      title: TITLE[kind](i.name),
      body: `${i.name} is where your customers already are, and your rivals aren't. Start small and see how they respond.`,
      why: `Your customers rank ${i.name} among their ${noun}; your rivals' customers don't.`,
      brief: [`Make it feel like ${c.brand}, in ${i.name}'s own style.`],
    });
  }
  return { plays };
}

export type PlayRow = {
  kind: PlayKind;
  title: string;
  rationale: string;
  why: string;
  brief: string[];
  rank: number;
  entityId: string;
  items: { entityId: string; name: string; kind: Kind; label: Label; rival: string | null; proof: string }[];
};

/**
 * Gemini's plays, kept only where the map backs them: refs that exist and aren't a rival's, all from
 * the first item's category, a kind that category can make, no two plays on the same item, at most
 * two per category and six in all. Order is Gemini's.
 */
export function keepBacked(answer: PlaysAnswer, c: PlayContext): PlayRow[] {
  const byRef = new Map(c.items.map((i) => [i.ref, i]));
  const used = new Set<string>();
  const perKind = new Map<PlayKind, number>();
  const rows: PlayRow[] = [];
  for (const p of answer.plays) {
    const refs = [...new Set(p.items.map((r) => r.trim().toLowerCase()))];
    const first = refs.map((r) => byRef.get(r)).find((i) => i && i.label !== "THEIRS");
    if (!first) continue;
    const kind = PLAY_OF[first.kind];
    if (!kind || used.has(first.entityId) || (perKind.get(kind) ?? 0) >= PER_CATEGORY) continue;
    const items = refs.map((r) => byRef.get(r)).filter((i): i is PlayItem => Boolean(i && i.label !== "THEIRS" && i.kind === first.kind));
    used.add(first.entityId);
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    rows.push({
      kind,
      title: p.title,
      rationale: p.body,
      why: p.why,
      brief: p.brief,
      rank: rows.length,
      entityId: first.entityId,
      items: items.map((i) => ({ entityId: i.entityId, name: i.name, kind: i.kind, label: i.label, rival: i.rival, proof: proofOf(i, c.rivals) })),
    });
    if (rows.length >= MAX_PLAYS) break;
  }
  return rows;
}
