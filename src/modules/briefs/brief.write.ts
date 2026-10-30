import { z } from "zod";
import type { PlayContext, PlayItem } from "@/modules/plays/plays";
import { customersWord, possessive, proofOf } from "@/modules/plays/plays";
import { categoryOf } from "@/modules/maps/map.shape";

/**
 * Write a brief (Figma: plays → "Write brief"): a one-page creative brief a business can hand to whoever
 * makes its next campaign, written from its own Culture Map. Pure; tested in tests/briefs.test.ts.
 *
 * Gemini writes the words; code keeps them honest. A line that claims something about the brand's
 * customers or rivals must cite map items by ref, and lines citing items that aren't on the map (or
 * are on the wrong side of it) are dropped, the same pattern as plays and re-cuts. The must-haves for
 * each channel come from code, not from the model.
 */

export const SECTIONS = ["ask", "audience", "insight", "proposition", "showUp", "avoid", "mandatories"] as const;
export type Section = (typeof SECTIONS)[number];
/** Section headings, in the brief's order. */
export const SECTION_TITLE: Record<Section, string> = {
  ask: "The ask",
  audience: "Who we’re talking to",
  insight: "What we know about them",
  proposition: "What to say",
  showUp: "Where to show up",
  avoid: "Steer clear of",
  mandatories: "Must-haves",
};
/** Sections whose every line has to rest on the map. */
const CITED: ReadonlySet<Section> = new Set(["audience", "insight", "showUp", "avoid"]);
const MAX_LINES: Record<Section, number> = { ask: 2, audience: 3, insight: 3, proposition: 2, showUp: 5, avoid: 3, mandatories: 6 };

const words = (max: number) => z.string().trim().min(1).max(max);
const line = z.object({ text: words(280), refs: z.array(z.string()).max(4).default([]) });

export const briefSchema = z.object({
  title: words(80),
  ask: z.array(line).min(1).max(2),
  audience: z.array(line).max(3),
  insight: z.array(line).max(3),
  proposition: z.array(line).min(1).max(2),
  tone: z.array(words(30)).max(4),
  showUp: z.array(line).max(5),
  avoid: z.array(line).max(3),
  mandatories: z.array(line).max(3),
});
export type BriefAnswer = z.infer<typeof briefSchema>;

export type BriefInput = {
  /** What it's for, in the person's words: "Summer launch", "Opening in Leeds". */
  occasion: string;
  placements: string[];
  /** Notes Ask X-Ray keeps about this person and business (guide memory). */
  notes: string[];
  audience: string | null;
  adRead: string | null;
};

const CHANNEL: Record<string, string> = { tiktok: "TikTok", reels: "Instagram Reels", shorts: "YouTube Shorts", youtube: "YouTube", feed: "Facebook and Instagram feed", stories: "Stories", tv: "TV and cinema", other: "other" };

export function briefPrompt(c: PlayContext, input: BriefInput) {
  const who = customersWord(c.through);
  const item = (i: PlayItem) => `${i.ref} · ${i.name} (${categoryOf(i.kind)?.noun.replace(/s$/, "") ?? "item"}) · ${i.label === "YOURS" ? "only theirs" : i.label === "CONTESTED" ? `shared with ${i.rival}` : `only ${i.rival}'s`} · ${i.rank < 99 ? `${i.rank}${i.rank === 1 ? "st" : i.rank === 2 ? "nd" : i.rank === 3 ? "rd" : "th"} on the list` : "lower on the list"}${i.detail ? ` · ${i.detail}` : ""}`;
  return [
    `You are a senior strategist writing a one-page creative brief for ${c.brand}, a brand in the ${c.market === "GB" ? "UK" : "US"}${c.rivals.length ? ` whose rivals are ${c.rivals.join(", ")}` : ""}.`,
    c.through?.length ? `Qloo doesn't know ${c.brand} yet, so its culture is read through ${c.through.join(", ")}: their customers stand in for ${possessive(c.brand)}. Say "${who}" or "people like ${possessive(c.brand)} customers", never "your customers".` : "",
    `What the brief is for: ${input.occasion}.`,
    `Where it will run: ${input.placements.length ? input.placements.map((p) => CHANNEL[p] ?? p).join(", ") : "not decided"}.`,
    input.notes.length ? `What the business has told us: ${input.notes.join("; ")}.` : "",
    "",
    "THE CULTURE MAP (what " + who + " like, from Qloo; refs in brackets)",
    ...c.items.map(item),
    "",
    ...(c.readings.length ? ["READINGS", ...c.readings.map((r) => `${categoryOf(r.kind)?.label ?? r.kind}: ${r.text}`), ""] : []),
    input.audience ? `WHO THEY ARE: ${input.audience}` : "",
    input.adRead ? `THEIR LATEST AD CHECK: ${input.adRead}` : "",
    "",
    "Write the brief in plain, confident British English for the people who will make the work. No scores, percentages or jargon (never 'affinity', 'index', 'over-index').",
    "- title: a short working title for the campaign.",
    "- ask: what the work has to do, in one or two sentences.",
    `- audience: who we're talking to, as people (what they listen to, watch, follow, where they go). Every line cites the items it uses in refs.`,
    `- insight: the one or two cultural truths the map shows, from items that are only theirs or lean their way. Cite refs.`,
    "- proposition: the single thing to say, as a line a creative could build from.",
    "- tone: up to four words or short phrases.",
    `- showUp: where to show up and with whom (podcasts, creators, places, shows), each from an item that is only theirs or shared; cite it.`,
    `- avoid: culture that belongs to a rival and would make the work look like theirs; cite those items (only rivals' items).`,
    "- mandatories: up to three must-haves specific to this brand and occasion (channel rules are added for you).",
    "Never invent names that aren't on the map. Never describe anyone's age, body, face or looks.",
    "Answer only with JSON that matches the schema.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Must-haves that hold for every ad on these channels, from the craft rules (adcheck.craft.ts). */
export function channelRules(brand: string, placements: string[]): string[] {
  const tall = placements.filter((p) => ["tiktok", "reels", "shorts", "stories"].includes(p));
  const rules = [
    `Show what ${brand} sells in the first two seconds, and say or show the name early.`,
    "End on one clear next step: where to find you, or how to order.",
  ];
  if (tall.length) rules.push(`Shoot tall (9:16) for ${tall.map((p) => CHANNEL[p]).join(" and ")}, with the subject in the middle third.`);
  if (placements.includes("feed")) rules.push("Make it work with the sound off: captions for anything said.");
  if (placements.includes("tiktok")) rules.push("Use sound on TikTok: voice or music, not silence.");
  if (placements.includes("youtube")) rules.push("Land the brand before the five-second skip on YouTube.");
  return rules;
}

export type CitedLine = { section: Section; text: string; refs: { entityId: string; name: string; label: PlayItem["label"]; rival: string | null; proof: string }[] };

/**
 * Keep only what the map backs: lines in cited sections need at least one real ref, on the right side
 * (avoid → a rival's; showUp, audience, insight → theirs or shared). Tone goes into the proposition
 * section; channel rules close the must-haves.
 */
export function toLines(a: BriefAnswer, c: PlayContext, placements: string[]): { title: string; lines: CitedLine[] } {
  const byRef = new Map(c.items.map((i) => [i.ref, i]));
  const okFor = (s: Section, i: PlayItem) => (s === "avoid" ? i.label === "THEIRS" : CITED.has(s) ? i.label !== "THEIRS" : true);
  const lines: CitedLine[] = [];
  for (const s of SECTIONS) {
    const given = s === "mandatories" ? [...a.mandatories, ...channelRules(c.brand, placements).map((text) => ({ text, refs: [] as string[] }))] : a[s];
    let kept = 0;
    for (const l of given) {
      if (kept >= MAX_LINES[s] + (s === "mandatories" ? 3 : 0)) break;
      const items = [...new Set(l.refs)].flatMap((r) => {
        const i = byRef.get(r.trim());
        return i && okFor(s, i) ? [i] : [];
      });
      if (CITED.has(s) && !items.length) continue;
      lines.push({ section: s, text: l.text, refs: items.map((i) => ({ entityId: i.entityId, name: i.name, label: i.label, rival: i.rival, proof: proofOf(i, c.rivals, c.through) })) });
      kept++;
    }
    if (s === "proposition" && a.tone.length) lines.push({ section: s, text: `Tone: ${a.tone.join(", ")}.`, refs: [] });
  }
  return { title: a.title, lines };
}

/** Practice mode: a schema-valid brief from the map's real items, so the page can be built at no cost. */
export function practiceBrief(c: PlayContext, input: BriefInput): BriefAnswer {
  const yours = c.items.filter((i) => i.label === "YOURS");
  const theirs = c.items.filter((i) => i.label === "THEIRS");
  const first = yours[0];
  return {
    title: input.occasion || `${c.brand} this season`,
    ask: [{ text: `Make ${possessive(c.brand)} ${input.occasion.toLowerCase() || "next campaign"} feel like it belongs to ${customersWord(c.through)}, not to ${c.rivals[0] ?? "a rival"}.`, refs: [] }],
    audience: first ? [{ text: `People who love ${yours.slice(0, 3).map((i) => i.name).join(", ")}.`, refs: yours.slice(0, 3).map((i) => i.ref) }] : [],
    insight: first ? [{ text: `${first.name} is high on their list and on no rival's.`, refs: [first.ref] }] : [],
    proposition: [{ text: `${c.brand}: made for the way you already spend your weekends.`, refs: [] }],
    tone: ["warm", "unhurried", "local"],
    showUp: yours.slice(0, 3).map((i) => ({ text: `Show up with ${i.name}.`, refs: [i.ref] })),
    avoid: theirs.slice(0, 2).map((i) => ({ text: `Avoid ${i.name}: it belongs to ${i.rival}.`, refs: [i.ref] })),
    mandatories: [],
  };
}
