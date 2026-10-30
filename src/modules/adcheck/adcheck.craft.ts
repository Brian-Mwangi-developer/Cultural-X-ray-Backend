/**
 * What would hold the ad back where it's going to run, from facts the check measured: its shape
 * against each chosen placement, when the product and the name first appear, sound and captions,
 * and whether it ends with something to do. Pure and deterministic, so every finding cites its
 * evidence ("1920 × 1080, landscape"; "product first at 0:12"). Computed when the ad is read, so ads
 * checked before this existed get it too.
 */

export type Placement = "tiktok" | "reels" | "shorts" | "youtube" | "feed" | "stories" | "tv" | "other";
export type Shape = "vertical" | "portrait" | "square" | "landscape";
export type Finding = {
  id: string;
  /** fix: it will hurt the ad where it runs. consider: worth doing. */
  level: "fix" | "consider";
  title: string;
  why: string;
  how: string;
  evidence: string[];
};

export const PLACEMENT_NAME: Record<Placement, string> = { tiktok: "TikTok", reels: "Instagram Reels", shorts: "YouTube Shorts", youtube: "YouTube", feed: "Facebook and Instagram feeds", stories: "Stories", tv: "TV and cinema", other: "other placements" };

/** The shape each placement shows full-size, and what the others fall back to. */
const WANTS: Partial<Record<Placement, { shapes: Shape[]; label: string }>> = {
  tiktok: { shapes: ["vertical"], label: "9:16 vertical" },
  reels: { shapes: ["vertical"], label: "9:16 vertical" },
  shorts: { shapes: ["vertical"], label: "9:16 vertical" },
  stories: { shapes: ["vertical"], label: "9:16 vertical" },
  feed: { shapes: ["portrait", "square", "vertical"], label: "4:5 or 1:1" },
  youtube: { shapes: ["landscape"], label: "16:9 landscape" },
  tv: { shapes: ["landscape"], label: "16:9 landscape" },
};
/** Placements that usually start muted, where captions carry the message. */
const MUTED: Placement[] = ["feed", "reels", "stories"];
/** How long a viewer gives an ad before skipping or scrolling, in seconds. */
const PATIENCE: Partial<Record<Placement, number>> = { youtube: 5, tiktok: 3, reels: 3, shorts: 3, stories: 3, feed: 3 };

export function shapeOf(width: number, height: number): Shape {
  const r = width / height;
  if (r <= 0.65) return "vertical"; // 9:16 is 0.5625
  if (r <= 0.9) return "portrait"; // 4:5 is 0.8
  if (r <= 1.15) return "square";
  return "landscape";
}

const SHAPE_WORDS: Record<Shape, string> = { vertical: "vertical", portrait: "portrait", square: "square", landscape: "landscape" };
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export type CraftFacts = {
  width: number | null;
  height: number | null;
  durationMs: number;
  placements: Placement[];
  brand: string;
  /** When the product is first clearly shown (from the fit check), if it is at all. */
  productAtMs: number | null;
  productKnown: boolean;
  onScreen: { text: string; kind: string; startMs: number }[];
  spokenLines: number;
  hasSound: boolean;
};

export function craftFindings(f: CraftFacts): Finding[] {
  const out: Finding[] = [];
  const places = f.placements.filter((p) => p !== "other");

  // 1. Shape: the first thing a platform decides is how big the ad is on screen.
  if (f.width && f.height) {
    const shape = shapeOf(f.width, f.height);
    const wrong = places.filter((p) => WANTS[p] && !WANTS[p]!.shapes.includes(shape));
    const byLabel = new Map<string, Placement[]>();
    for (const p of wrong) byLabel.set(WANTS[p]!.label, [...(byLabel.get(WANTS[p]!.label) ?? []), p]);
    for (const [label, ps] of byLabel) {
      const vertical = label.startsWith("9:16");
      out.push({
        id: `shape-${label}`,
        level: "fix",
        title: `${names(ps.map((p) => PLACEMENT_NAME[p]))} want${ps.length === 1 && !/s$/.test(PLACEMENT_NAME[ps[0]!]) ? "s" : ""} ${label}; this ad is ${SHAPE_WORDS[shape]}`,
        why: vertical
          ? `A ${SHAPE_WORDS[shape]} ad on a full-screen vertical feed plays small between bars or gets cropped at the sides, so the product and any words near the edges can be lost, and it reads as an ad made for somewhere else.`
          : `It will be letterboxed or cropped to fit, which shrinks the product and can cut words at the edges.`,
        how: vertical
          ? "Re-frame a 9:16 version: keep the product and the name in the middle third, and keep words out of the top and bottom bands where the app puts its own buttons and captions."
          : `Make a ${label} version, framed for it rather than cropped from this one.`,
        evidence: [`${f.width} × ${f.height}, ${SHAPE_WORDS[shape]}`, `chosen: ${names(ps.map((p) => PLACEMENT_NAME[p]))}`],
      });
    }
  }

  // 2. The first seconds: where people skip or scroll.
  const patience = Math.min(...places.map((p) => PATIENCE[p] ?? 99));
  if (Number.isFinite(patience) && patience < 99 && f.productKnown) {
    const where = places.find((p) => PATIENCE[p] === patience)!;
    if (f.productAtMs == null || f.productAtMs > patience * 1000) {
      out.push({
        id: "hook-product",
        level: "fix",
        title: f.productAtMs == null ? "The product never clearly appears" : `The product first appears at ${clock(f.productAtMs)}`,
        why: where === "youtube" ? "On YouTube most people skip at five seconds; whatever they haven’t seen by then, they don’t see." : `On ${PLACEMENT_NAME[where]} people decide in the first ${patience} seconds whether to keep watching; a slow start loses them before the product does any work.`,
        how: "Open on the product, or bring its best shot to the front: the first frame should already say what this is.",
        evidence: [f.productAtMs == null ? "not seen in any shot" : `first seen at ${clock(f.productAtMs)}`, `${PLACEMENT_NAME[where]}: about ${patience} s to win attention`],
      });
    }
  }
  const nameAt = f.onScreen.find((t) => t.text.toLowerCase().includes(f.brand.toLowerCase().replace(/['’]s$/, "")))?.startMs ?? null;
  if (places.length && nameAt != null && nameAt > f.durationMs * 0.7 && f.durationMs > 10_000) {
    out.push({
      id: "hook-name",
      level: "consider",
      title: `${f.brand}’s name only appears at ${clock(nameAt)}`,
      why: "People who scroll on before the end never learn whose ad it was, so the views build someone else’s category, not your name.",
      how: "Put the name on screen once early, small is fine, and keep the end card.",
      evidence: [`name first on screen at ${clock(nameAt)} of ${clock(f.durationMs)}`],
    });
  }

  // 3. Sound: feeds start muted; TikTok is built for sound.
  const muted = places.filter((p) => MUTED.includes(p));
  if (muted.length && f.spokenLines > 0 && f.onScreen.length < Math.ceil(f.spokenLines / 2)) {
    out.push({
      id: "sound-captions",
      level: "fix",
      title: "What’s said isn’t on screen",
      why: `${names(muted.map((p) => PLACEMENT_NAME[p]))} often play with the sound off, so the spoken lines carry nothing for those viewers.`,
      how: "Burn in captions for the key lines, or put the one line that matters on screen.",
      evidence: [`${f.spokenLines} spoken line${f.spokenLines === 1 ? "" : "s"}`, `${f.onScreen.length} on-screen text item${f.onScreen.length === 1 ? "" : "s"}`],
    });
  }
  if (places.includes("tiktok") && !f.hasSound) {
    out.push({
      id: "sound-tiktok",
      level: "consider",
      title: "The ad is silent, and TikTok is watched with sound",
      why: "On TikTok a silent ad feels like an interruption rather than part of the feed.",
      how: "Add music or a voice from TikTok’s Commercial Music Library, or a simple voice-over saying what you offer.",
      evidence: ["no music or speech heard"],
    });
  }

  // 4. What to do next.
  if (!f.onScreen.some((t) => t.kind === "call_to_action")) {
    out.push({
      id: "next-step",
      level: "consider",
      title: "It doesn’t end with one thing to do",
      why: "Someone who liked it has nowhere to go next, so the interest fades before it becomes a visit or an order.",
      how: "End with one plain step and where to do it: ‘Order on our site’, ‘Find us on Deliveroo’, ‘Visit us in [your town]’.",
      evidence: ["no call to action on screen"],
    });
  }
  return out;
}
