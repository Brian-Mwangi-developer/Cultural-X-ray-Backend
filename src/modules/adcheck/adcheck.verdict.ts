import { z } from "zod";
import { type AdContext, PEOPLE_RULE, type ShotDescription } from "@/modules/adcheck/adcheck.shape";

/**
 * Placing an ad on the Culture Map, and the verdict in words. Pure; tested in tests/adcheck.test.ts.
 *
 * How (probe of 26 October, plan-ad-check.md Phase 2): Gemini rewrites each shot into a few cues a
 * taste graph knows (lifestyles, hobbies, moods, media keywords). Each cue → Qloo tags of the types
 * that carry brand signal → each tag scored against your side and every rival → the clearest tag
 * wins. Settings and visual style have no brand signal in Qloo, so they are never scored, and a cue
 * with no read is said to have none.
 */

// ── Cues (fast model, text only) ────────────────────────────────────────────────────────────────

export const cuesSchema = z.object({
  shots: z.array(z.object({ index: z.number().int().min(0).max(39), cues: z.array(z.string().trim().min(2).max(40)).max(5) })).max(40),
  whole: z.array(z.string().trim().min(2).max(40)).max(8),
});
export type Cues = z.infer<typeof cuesSchema>;

export function cuesPrompt(context: AdContext, shots: { index: number; description: ShotDescription }[], music: string) {
  return [
    "You are turning an ad into cues a cultural taste graph understands.",
    `The ad: ${context.story}`,
    music ? `Music: ${music}.` : "",
    "Shots:",
    ...shots.map(({ index, description: d }) => `${index}. ${d.action} Setting: ${d.setting}. Mood: ${d.mood}.${d.styling.length ? ` Style: ${d.styling.join(", ")}.` : ""}`),
    "",
    "For each shot, give up to 5 cues of 1 to 3 words, the kind a person would list as a taste or way of life:",
    "- lifestyles (cozy, luxury leisure, minimalism), hobbies and activities (skateboarding, surfing, home cooking),",
    "- moods as adjectives (playful, laid-back, rebellious), and everyday situations (family dinner, office worker, date night).",
    "Don't give colours, lighting, camera words or descriptions of places. Use plain lowercase words, no brand names.",
    "whole: up to 8 cues for the ad as a whole.",
    PEOPLE_RULE,
    "Answer only with JSON that matches the schema.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const practiceCues = (indexes: number[]): Cues => {
  const sets = [["cozy", "home cooking", "laid-back"], ["playful", "family dinner"], ["minimalism"]];
  return { shots: indexes.map((index) => ({ index, cues: sets[index % sets.length]! })), whole: ["cozy", "playful", "family dinner"] };
};

/** Cues as one clean list: lowercase, de-duplicated, whole-ad cues last, at most `max`. */
export function uniqueCues(cues: Cues, max = 24): string[] {
  const all = [...cues.shots.flatMap((s) => s.cues), ...cues.whole].map((c) => c.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
  return [...new Set(all)].slice(0, max);
}

// ── Scoring one cue ─────────────────────────────────────────────────────────────────────────────

/** Tag types that carried brand signal in the probe; the rest (view, style, decor, interests…) never did. */
export const CUE_TAG_TYPES = ["lifestyle:qloo", "hobby:qloo", "keyword:media", "genre:media", "adjective:qloo", "subgenre:qloo"].map((t) => `urn:tag:${t}`);

/** Qloo's "no data" affinities: 0.764996 in brand-vs-tag answers, plus the map's known ones. */
const FILLERS = [0.7649962877984056, 0.554054, 0.76];
export const hasSignal = (a: number | undefined): a is number => typeof a === "number" && !FILLERS.some((f) => Math.abs(a - f) < 5e-6);

/** A gap smaller than this is shared ground. */
export const CLOSE = 0.03;

export type Side = { you: string[]; rivals: { id: string; name: string }[] };
export type Judged = { territory: "YOURS" | "CONTESTED" | "THEIRS"; rival: string | null; gap: number };

/**
 * Who a tag belongs to, from each brand's affinity to it. Your side is the strongest of your brand
 * and the brands your customers also buy; a rival is one brand. Null when nobody has a real score.
 */
export function judge(affinity: Map<string, number>, side: Side): Judged | null {
  const yours = Math.max(-1, ...side.you.map((id) => affinity.get(id)).filter(hasSignal));
  const rivals = side.rivals.map((r) => ({ ...r, a: affinity.get(r.id) })).filter((r): r is typeof r & { a: number } => hasSignal(r.a)).sort((x, y) => y.a - x.a);
  const top = rivals[0];
  if (yours < 0 && !top) return null;
  if (!top) return { territory: "YOURS", rival: null, gap: yours };
  if (yours < 0) return { territory: "THEIRS", rival: top.name, gap: top.a };
  const gap = yours - top.a;
  if (gap >= CLOSE) return { territory: "YOURS", rival: null, gap };
  if (gap <= -CLOSE) return { territory: "THEIRS", rival: top.name, gap: -gap };
  return { territory: "CONTESTED", rival: top.name, gap: Math.abs(gap) };
}

/** The clearest of a cue's tags: one side ahead beats shared ground, then the biggest gap. */
export function clearest<T extends { judged: Judged | null }>(candidates: T[]): (T & { judged: Judged }) | null {
  const live = candidates.filter((c): c is T & { judged: Judged } => c.judged !== null);
  return live.sort((a, b) => Number(b.judged.territory !== "CONTESTED") - Number(a.judged.territory !== "CONTESTED") || b.judged.gap - a.judged.gap)[0] ?? null;
}

// ── The verdict ─────────────────────────────────────────────────────────────────────────────────

export type PlacedCue = { cue: string; tag: { id: string; name: string; type: string } | null; judged: Judged | null };
export type PlacedReference = { name: string; territory: "YOURS" | "CONTESTED" | "THEIRS" | null; rival: string | null };

type Item = { cue: string; shots: number[] };
export type Verdict = {
  lean: "yours" | "theirs" | "mixed" | "unclear";
  rival: string | null;
  headline: string;
  yours: Item[];
  shared: (Item & { rival: string })[];
  theirs: (Item & { rival: string })[];
  noRead: string[];
  references: { name: string; says: string }[];
  reshoot: string[];
  notes: string[];
};

export function list(words: string[]) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** A shot's territory: the side most of its placed cues fall on; ties are shared. */
export function shotTerritory(placed: PlacedCue[]): "YOURS" | "CONTESTED" | "THEIRS" | null {
  const count = { YOURS: 0, CONTESTED: 0, THEIRS: 0 };
  for (const p of placed) if (p.judged) count[p.judged.territory]++;
  if (!count.YOURS && !count.THEIRS && !count.CONTESTED) return null;
  if (count.YOURS > count.THEIRS) return "YOURS";
  if (count.THEIRS > count.YOURS) return "THEIRS";
  return "CONTESTED";
}

/**
 * Words only (no scores): which way the ad leans, what pulls it there, what's already yours, what
 * Qloo can't read, and what to reshoot.
 */
export function verdictFrom(placed: Map<string, PlacedCue>, shotCues: { index: number; cues: string[] }[], references: PlacedReference[] = []): Verdict {
  const shotsOf = (cue: string) => shotCues.filter((s) => s.cues.some((c) => c.toLowerCase().trim() === cue)).map((s) => s.index);
  const yours: Item[] = [];
  const shared: (Item & { rival: string })[] = [];
  const theirs: (Item & { rival: string })[] = [];
  const noRead: string[] = [];
  for (const p of placed.values()) {
    const item = { cue: p.cue, shots: shotsOf(p.cue) };
    if (!p.judged) noRead.push(p.cue);
    else if (p.judged.territory === "YOURS") yours.push(item);
    else if (p.judged.territory === "THEIRS") theirs.push({ ...item, rival: p.judged.rival! });
    else shared.push({ ...item, rival: p.judged.rival! });
  }
  // Cues seen in more shots matter more.
  const weight = (i: Item) => Math.max(1, i.shots.length);
  for (const arr of [yours, shared, theirs]) arr.sort((a, b) => weight(b) - weight(a));
  const y = yours.reduce((n, i) => n + weight(i), 0);
  const t = theirs.reduce((n, i) => n + weight(i), 0);
  const byRival = new Map<string, number>();
  for (const i of theirs) byRival.set(i.rival, (byRival.get(i.rival) ?? 0) + weight(i));
  const rival = [...byRival.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? shared[0]?.rival ?? null;

  const top = (items: Item[]) => list(items.slice(0, 3).map((i) => i.cue));
  let lean: Verdict["lean"];
  let headline: string;
  if (!y && !t && !shared.length) {
    lean = "unclear";
    headline = "Qloo has little to say about this ad yet, so we can't tell whose customers it speaks to.";
  } else if (y && y >= 2 * t) {
    lean = "yours";
    headline = `This ad reads as yours: ${top(yours)} ${yours.length > 1 ? "are" : "is"} what your customers are into.`;
  } else if (t && t >= 2 * y) {
    lean = "theirs";
    headline = `This ad leans toward ${rival}: ${top(theirs)} ${theirs.length > 1 ? "belong" : "belongs"} to their customers more than yours.`;
  } else if (y || t) {
    lean = "mixed";
    headline = `This ad pulls both ways: ${top(yours) || "little"} toward you, ${top(theirs) || top(shared)} toward ${rival}.`;
  } else {
    lean = "mixed";
    headline = `This ad sits on shared ground: ${top(shared)} ${shared.length > 1 ? "are" : "is"} liked by your customers and ${rival} customers alike.`;
  }

  const reshoot = theirs
    .filter((i) => i.shots.length)
    .slice(0, 4)
    .map((i) => `${i.shots.length > 1 ? "Shots" : "Shot"} ${list(i.shots.map((n) => String(n + 1)))}: "${i.cue}" pulls toward ${i.rival}.`);
  const notes = [
    ...(noRead.length ? [`Qloo has no read on ${list(noRead.slice(0, 3))}${noRead.length > 3 ? " and a few more" : ""}.`] : []),
    "Settings and visual style aren't placed: Qloo doesn't link them to brands.",
  ];
  const says = (r: PlacedReference) =>
    r.territory === "YOURS"
      ? "yours"
      : r.territory === "THEIRS"
        ? r.rival === r.name
          ? "your rival"
          : `closer to ${r.rival}`
        : r.territory === "CONTESTED"
          ? `shared with ${r.rival}`
          : "not on your map";

  return { lean, rival: lean === "yours" || lean === "unclear" ? null : rival, headline, yours, shared, theirs, noRead, references: references.map((r) => ({ name: r.name, says: says(r) })), reshoot, notes };
}

export const noMapVerdict = (): Verdict => ({
  lean: "unclear",
  rival: null,
  headline: "Build your Culture Map first: it's what the ad is compared with.",
  yours: [],
  shared: [],
  theirs: [],
  noRead: [],
  references: [],
  reshoot: [],
  notes: [],
});
