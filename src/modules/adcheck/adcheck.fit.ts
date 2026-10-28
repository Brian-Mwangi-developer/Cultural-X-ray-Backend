import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { PEOPLE_RULE } from "@/modules/adcheck/adcheck.shape";
import { generate } from "@/modules/gemini/gemini.client";
import type { Attribution } from "@/modules/usage/ai-calls";

/**
 * Before mood and culture: does this ad show what the business sells, under its own name, and say
 * it plainly? Tried live on 28 October: an ice-cream ad with a "Jude's" end card checked on a pizza
 * brand got scene-and-mood advice only. This reads what the check already stored (each shot's
 * description, on-screen text, script, logos and references), so it needs no second look at the video
 * and can run on ads checked before it existed. Fast model, text only.
 */

const words = (max: number) => z.string().trim().min(1).max(max);

export const fitSchema = z.object({
  /** What the ad actually shows or offers, in a few words: "ice cream cones and scoops". */
  adShows: words(120),
  /** yes: the business's product or service is clearly there. partly: hinted, late or unclear. no: something else. */
  fits: z.enum(["yes", "partly", "no"]),
  /** Brand names or logos seen or heard that aren't this business. */
  otherBrands: z.array(words(80)).max(6),
  /** Whether the business's own name appears or is said. */
  nameShown: z.boolean(),
  /** Does the ad say what the business offers? clear, vague (could be anyone's), or missing. */
  message: z.enum(["clear", "vague", "missing"]),
  /** One plain sentence for the owner, the headline of the flag. */
  headline: words(160),
  /** Two or three sentences: what was seen, and why it matters to customers. */
  why: words(500),
  /** Up to three changes, most important first: what to do, and why in a short line. */
  advice: z.array(z.object({ what: words(200), why: words(200) })).max(3),
});
export type Fit = z.infer<typeof fitSchema>;

export type Business = { name: string; sells: string | null; through: string[] };

type Meta = { brand?: { name?: string; sells?: string; categories?: string[] }; category?: { name?: string } | null; seeds?: { name: string }[] };

/** What the business told us at onboarding: its name and what it sells. */
export function businessOf(name: string, metadata: string | null, known: boolean): Business {
  let m: Meta = {};
  try {
    m = metadata ? (JSON.parse(metadata) as Meta) : {};
  } catch {
    m = {};
  }
  const sells = m.brand?.sells?.trim() || m.category?.name || m.brand?.categories?.join(", ") || null;
  return { name: m.brand?.name || name, sells, through: known ? [] : (m.seeds ?? []).map((s) => s.name) };
}

export type AdFacts = { shots: { index: number; action: string; setting: string; objects: string[]; text: string[] }[]; onScreen: string[]; script: string[]; logos: string[]; references: string[] };

export function fitPrompt(b: Business, f: AdFacts) {
  const shots = f.shots.map((s) => `Shot ${s.index + 1}: ${s.action} Setting: ${s.setting}.${s.objects.length ? ` Objects: ${s.objects.join(", ")}.` : ""}${s.text.length ? ` Text: ${s.text.map((t) => `"${t}"`).join(", ")}.` : ""}`);
  return [
    `You are checking a draft ad for ${b.name}${b.sells ? `, a business that sells ${b.sells}` : ""}.${b.through.length ? ` It is a new brand; its customers are expected to be like ${b.through.join(", ")} customers.` : ""}`,
    "Below is what the ad shows and says, as our system read it.",
    "",
    "SHOTS",
    ...shots,
    `ON-SCREEN TEXT: ${f.onScreen.length ? f.onScreen.map((t) => `"${t}"`).join("; ") : "none"}`,
    `SPOKEN: ${f.script.length ? f.script.map((t) => `"${t}"`).join("; ") : "nothing"}`,
    `LOGOS AND BRANDS SEEN: ${f.logos.length ? f.logos.join(", ") : "none"}`,
    `NAMED REFERENCES: ${f.references.length ? f.references.join(", ") : "none"}`,
    "",
    `Answer, as a straight-talking creative director would to the owner of ${b.name}:`,
    `- adShows: what product or service the ad actually shows or offers.`,
    `- fits: "yes" if ${b.sells ?? "what the business sells"} is clearly the subject; "partly" if it's there but late, small or unclear; "no" if the ad shows something else (a different product or category).`,
    `- otherBrands: names or logos of any brand that isn't ${b.name} (never list ${b.name} itself).`,
    `- nameShown: whether ${b.name}'s own name is seen or said.`,
    `- message: "clear" if a viewer would know what ${b.name} offers and why it's worth trying; "vague" if the ad could be for anyone in the category; "missing" if it never says.`,
    "- headline: one plain sentence for the owner. If it doesn't fit, say what the ad sells and what the business sells.",
    "- why: what you saw that led there, and what customers would come away believing.",
    "- advice: up to three concrete changes, most important first. Be specific to this business (its product, its name, its offer). Prefer clear over loud: one plain line beats a slogan that could be anyone's. Keep what works. Never invent facts about the business beyond what's given; where a detail is needed, say what kind of detail (\"your city\", \"your best seller\").",
    PEOPLE_RULE,
    "Answer only with JSON that matches the schema.",
  ].join("\n");
}

export const practiceFit = (b: Business): Fit => ({
  adShows: b.sells ?? "the product",
  fits: "yes",
  otherBrands: [],
  nameShown: true,
  message: "clear",
  headline: `The ad shows what ${b.name} sells, under its own name.`,
  why: "The product is the subject of the ad and the name is on screen.",
  advice: [],
});

/** The facts the fit check reads, from what the ad check stored. */
export async function factsOf(adId: string): Promise<AdFacts> {
  const ad = await prisma.ad.findUniqueOrThrow({
    where: { id: adId },
    select: {
      shots: { orderBy: { index: "asc" }, select: { index: true, description: true } },
      elements: { where: { kind: { in: ["ONSCREEN_TEXT", "SCRIPT", "LOGO", "REFERENCE"] } }, orderBy: { startMs: "asc" }, select: { kind: true, raw: true } },
    },
  });
  const pick = (kind: string) => [...new Set(ad.elements.filter((e) => e.kind === kind).map((e) => e.raw))];
  return {
    shots: ad.shots.flatMap((s) => {
      const d = s.description as { action?: string; setting?: string; objects?: string[]; text?: string[] } | null;
      return d?.action ? [{ index: s.index, action: d.action, setting: d.setting ?? "", objects: d.objects ?? [], text: d.text ?? [] }] : [];
    }),
    onScreen: pick("ONSCREEN_TEXT").slice(0, 20),
    script: pick("SCRIPT").slice(0, 20),
    logos: pick("LOGO").slice(0, 10),
    references: pick("REFERENCE").slice(0, 10),
  };
}

/**
 * Check the ad against what the business sells and store the answer on its latest check (verdict.fit).
 * Returns null when there's no check to attach it to.
 */
export async function checkFit(adId: string, who: Attribution): Promise<Fit | null> {
  const ad = await prisma.ad.findUniqueOrThrow({
    where: { id: adId },
    select: {
      workspace: { select: { name: true, metadata: true } },
      checks: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, verdict: true, map: { select: { subjects: { select: { role: true } } } } } },
    },
  });
  const check = ad.checks[0];
  if (!check) return null;
  const known = check.map.subjects.some((s) => s.role === "SELF");
  const business = businessOf(ad.workspace.name, ad.workspace.metadata, known);
  const facts = await factsOf(adId);
  const { json } = await generate({ stage: "fit", tier: "fast", parts: [fitPrompt(business, facts)], schema: fitSchema, practice: practiceFit(business), attribution: who });
  const fit: Fit = { ...json, otherBrands: json.otherBrands.filter((n) => n.trim().toLowerCase() !== business.name.trim().toLowerCase()) };
  await prisma.adCheck.update({ where: { id: check.id }, data: { verdict: { ...(check.verdict as Prisma.JsonObject), fit } as unknown as Prisma.InputJsonObject } });
  return fit;
}
