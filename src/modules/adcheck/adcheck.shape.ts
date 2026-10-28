import { z } from "zod";
import type { ElementKind } from "@/generated/prisma/client";

/**
 * The ad check's pure parts: what each Gemini pass must answer, the prompts, practice answers,
 * the shot list, and turning answers into saved elements. No I/O; tested in tests/adcheck.test.ts.
 *
 * Schema rules (Vertex): fixed values are one-value enums (no `const`), arrays stay at 40 or fewer
 * (60 was rejected), and times are seconds from the start of the ad.
 */

const MAX = 40;
const words = (max = 200) => z.string().trim().min(1).max(max);
const at = z.number().min(0).max(3_600);

// ── The people rule ─────────────────────────────────────────────────────────────────────────────
// A request for children's "age range, look" got the Vertex project blocked on 25 October 2026.
// Every prompt carries this rule; no prompt asks for anything it forbids (checked by a test).

export const PEOPLE_RULE =
  "About people: describe each person only by their role in the ad (for example shopper, parent, chef, narrator) and what they are doing, saying or wearing. Never describe or estimate anyone's age, body, face, skin, ethnicity or looks, and never try to identify a real person from their face. Only name a person when the ad itself names them on screen or out loud.";

// ── Pass 1: context, the whole ad (fast model) ──────────────────────────────────────────────────

export const contextSchema = z.object({
  story: words(600),
  people: z.array(z.object({ role: words(80), doing: words(200) })).max(12),
  settings: z.array(z.object({ name: words(120), kind: z.enum(["indoor", "outdoor", "studio", "graphic", "mixed"]) })).max(12),
  objects: z.array(words(80)).max(MAX),
  brands: z.array(z.object({ name: words(80), how: z.enum(["logo", "product", "mention", "end_card"]) })).max(12),
  references: z.array(z.object({ name: words(120), kind: z.enum(["person", "place", "title", "event", "brand", "other"]) })).max(20),
});
export type AdContext = z.infer<typeof contextSchema>;

// ── Pass 2: on-screen text, whole ad at high resolution (fast model) ────────────────────────────

export const textSchema = z.object({
  items: z.array(z.object({ text: words(300), startS: at, endS: at, kind: z.enum(["headline", "caption", "logo", "price", "legal", "call_to_action", "other"]) })).max(MAX),
});
export type AdText = z.infer<typeof textSchema>;

// ── Pass 3: what is heard (fast model) ──────────────────────────────────────────────────────────

export const audioSchema = z.object({
  script: z.array(z.object({ startS: at, endS: at, speaker: words(80), words: words(500) })).max(MAX),
  music: z.object({
    present: z.boolean(),
    genre: z.string().max(80),
    mood: z.string().max(80),
    tempo: z.enum(["none", "slow", "medium", "fast"]),
    vocals: z.enum(["none", "sung", "spoken", "both"]),
  }),
  sounds: z.array(z.object({ startS: at, what: words(120) })).max(20),
});
export type AdAudio = z.infer<typeof audioSchema>;

// ── Pass 4: one shot, clipped (smart model) ─────────────────────────────────────────────────────

export const shotSchema = z.object({
  setting: words(200),
  action: words(300),
  people: z.array(z.object({ role: words(80), doing: words(200) })).max(8),
  objects: z.array(words(80)).max(20),
  styling: z.array(words(120)).max(10),
  mood: words(120),
  framing: z.enum(["close", "medium", "wide", "aerial", "graphic", "other"]),
  text: z.array(words(200)).max(10),
});
export type ShotDescription = z.infer<typeof shotSchema>;

// ── Prompts ─────────────────────────────────────────────────────────────────────────────────────

const JSON_ONLY = "Answer only with JSON that matches the schema. If something isn't in the ad, leave its list empty rather than guessing.";

export const prompts = {
  context: () =>
    [
      "You are reading a video ad for a brand strategist. Describe the whole ad:",
      "- story: what happens, start to end, in two to four plain sentences.",
      "- people: each person or character, by role and what they do.",
      "- settings: each place the ad is set in.",
      "- objects: the products and props that matter to the story.",
      "- brands: every brand shown or said, and how (logo, product, mention, end card).",
      "- references: named places, titles (films, songs, shows), events, or people the ad itself names.",
      PEOPLE_RULE,
      JSON_ONLY,
    ].join("\n"),
  text: () =>
    [
      "List every piece of text that appears on screen in this ad, in order, with when it appears and disappears (seconds from the start).",
      "Copy the words exactly as shown, including spelling and capitals. Text that stays on screen across cuts is one item.",
      "kind: headline, caption (words matching speech), logo, price, legal (small print), call_to_action, or other.",
      JSON_ONLY,
    ].join("\n"),
  audio: () =>
    [
      "Listen to this ad.",
      "- script: every line spoken or sung, with start and end in seconds, and the speaker by role (narrator, customer, singer…).",
      "- music: whether there is music, its genre, its mood in a few words, its tempo, and whether it has vocals.",
      "- sounds: other sounds that matter (a door, a crowd, a notification), with when they happen.",
      "Only report what you actually hear. If nobody speaks, script is empty; if there is no music, set present to false. Never infer speech or music from what the pictures or on-screen text suggest.",
      PEOPLE_RULE,
      JSON_ONLY,
    ].join("\n"),
  shot: (index: number, total: number, startS: number, endS: number, context: AdContext) =>
    [
      `This clip is shot ${index + 1} of ${total} in an ad, from ${startS.toFixed(2)} s to ${endS.toFixed(2)} s.`,
      `What the whole ad is about: ${context.story}`,
      context.people.length ? `People in the ad: ${context.people.map((p) => p.role).join(", ")}.` : "",
      "Describe only this shot:",
      "- setting: where it is, specifically (a kitchen at night, a city rooftop, a white studio).",
      "- action: what happens in it.",
      "- people: who is in it, by role, and what each is doing.",
      "- objects: products and props you can see.",
      "- styling: clothing and visual style (palette, lighting, era, design).",
      "- mood: the feeling of the shot in a few words.",
      "- framing: close, medium, wide, aerial, graphic (all text or animation) or other.",
      "- text: any words on screen in this shot.",
      PEOPLE_RULE,
      JSON_ONLY,
    ]
      .filter(Boolean)
      .join("\n"),
};

// ── Practice answers (GEMINI_PROVIDER=practice): schema-valid, no cost ───────────────────────────

export const practice = {
  context: {
    story: "A family gets ready for an evening together. The parent cooks while the kids set the table, and the ad ends on the brand's end card.",
    people: [
      { role: "parent", doing: "cooks dinner and plates it" },
      { role: "kids", doing: "set the table and laugh" },
    ],
    settings: [
      { name: "home kitchen in the evening", kind: "indoor" },
      { name: "dining room", kind: "indoor" },
    ],
    objects: ["pasta", "table setting", "candles"],
    brands: [{ name: "Practice Brand", how: "end_card" }],
    references: [],
  } satisfies AdContext,
  text: {
    items: [
      { text: "Dinner, sorted.", startS: 1, endS: 3, kind: "headline" },
      { text: "Practice Brand", startS: 12, endS: 15, kind: "logo" },
    ],
  } satisfies AdText,
  audio: {
    script: [{ startS: 2, endS: 5, speaker: "narrator", words: "Some nights, dinner just comes together." }],
    music: { present: true, genre: "acoustic folk", mood: "warm, easy", tempo: "medium", vocals: "none" },
    sounds: [{ startS: 6, what: "pan sizzling" }],
  } satisfies AdAudio,
  shot: (index: number): ShotDescription => {
    const scenes = [
      { setting: "home kitchen in the evening", action: "the parent stirs a pan of pasta", people: [{ role: "parent", doing: "cooking at the stove" }], objects: ["pan", "pasta"], styling: ["warm tungsten light", "casual knitwear"], mood: "cosy, unhurried", framing: "medium" as const },
      { setting: "dining room", action: "the kids lay plates and light candles", people: [{ role: "kids", doing: "setting the table" }], objects: ["plates", "candles"], styling: ["soft evening light"], mood: "playful", framing: "wide" as const },
      { setting: "white studio end card", action: "the brand's logo appears", people: [], objects: ["logo"], styling: ["clean white background"], mood: "calm", framing: "graphic" as const },
    ];
    return { ...scenes[index % scenes.length]!, text: index % 3 === 2 ? ["Practice Brand"] : [] };
  },
};

// ── Shots ───────────────────────────────────────────────────────────────────────────────────────

export type Shot = { index: number; startMs: number; endMs: number };

/** Shots shorter than this are folded into the one before (flashes, dissolve frames). */
export const MIN_SHOT_MS = 400;
export const MAX_SHOTS = MAX;

/** Cut times from ffmpeg's `select='gt(scene,T)',showinfo` log (stderr). */
export function cutsFromShowinfo(log: string): number[] {
  const cuts: number[] = [];
  for (const m of log.matchAll(/Parsed_showinfo.*?pts_time:\s*([0-9.]+)/g)) cuts.push(Math.round(Number(m[1]) * 1000));
  return cuts;
}

/**
 * Cut times → shots. Cuts outside the ad or too close together are dropped, short shots merge into
 * the previous one, and the shortest neighbours merge until there are at most MAX_SHOTS.
 */
export function shotsFrom(cutsMs: number[], durationMs: number): Shot[] {
  const cuts = [...new Set(cutsMs.map(Math.round))].filter((c) => c > 0 && c < durationMs).sort((a, b) => a - b);
  let bounds = [0, ...cuts, durationMs];
  // Drop boundaries that make a too-short shot (the last shot merges backwards).
  const kept = [0];
  for (const b of bounds.slice(1)) {
    if (b - kept.at(-1)! >= MIN_SHOT_MS) kept.push(b);
    else if (b === durationMs && kept.length > 1) kept[kept.length - 1] = durationMs;
  }
  if (kept.at(-1) !== durationMs) kept.push(durationMs);
  bounds = kept.length >= 2 ? kept : [0, durationMs];
  while (bounds.length - 1 > MAX_SHOTS) {
    // Remove the inner boundary whose two sides add up to the shortest merged shot.
    let best = 1;
    for (let i = 1; i < bounds.length - 1; i++) if (bounds[i + 1]! - bounds[i - 1]! < bounds[best + 1]! - bounds[best - 1]!) best = i;
    bounds.splice(best, 1);
  }
  return bounds.slice(0, -1).map((start, index) => ({ index, startMs: start, endMs: bounds[index + 1]! }));
}

// ── Answers → elements ──────────────────────────────────────────────────────────────────────────

export type ElementRow = { kind: ElementKind; raw: string; detail?: Record<string, unknown>; startMs: number; endMs: number };

const ms = (s: number, durationMs: number) => Math.min(Math.max(0, Math.round(s * 1000)), durationMs);

/** What was seen and heard, as rows for ad_element. Times are clamped to the ad; end never before start. */
export function elementsFrom(durationMs: number, context: AdContext, text: AdText, audio: AdAudio, shots: { shot: Shot; description: ShotDescription | null }[]): ElementRow[] {
  const span = (startS: number, endS: number) => {
    const startMs = ms(startS, durationMs);
    return { startMs, endMs: Math.max(startMs, ms(endS, durationMs)) };
  };
  const whole = { startMs: 0, endMs: durationMs };
  const rows: ElementRow[] = [
    ...context.settings.map((s) => ({ kind: "SETTING" as const, raw: s.name, detail: { kind: s.kind, from: "context" }, ...whole })),
    ...context.references.map((r) => ({ kind: "REFERENCE" as const, raw: r.name, detail: { kind: r.kind }, ...whole })),
    ...context.brands.map((b) => ({ kind: "LOGO" as const, raw: b.name, detail: { how: b.how }, ...whole })),
    ...text.items.map((t) => ({ kind: "ONSCREEN_TEXT" as const, raw: t.text, detail: { kind: t.kind }, ...span(t.startS, t.endS) })),
    ...audio.script.map((line) => ({ kind: "SCRIPT" as const, raw: line.words, detail: { speaker: line.speaker }, ...span(line.startS, line.endS) })),
    ...(audio.music.present ? [{ kind: "SOUND" as const, raw: audio.music.genre || "music", detail: { music: true, mood: audio.music.mood, tempo: audio.music.tempo, vocals: audio.music.vocals }, ...whole }] : []),
    ...audio.sounds.map((s) => ({ kind: "SOUND" as const, raw: s.what, detail: { music: false }, ...span(s.startS, s.startS) })),
  ];
  for (const { shot, description } of shots) {
    if (!description) continue;
    const t = { startMs: shot.startMs, endMs: shot.endMs };
    rows.push({ kind: "SETTING", raw: description.setting, detail: { shot: shot.index, from: "shot" }, ...t });
    for (const s of description.styling) rows.push({ kind: "STYLING", raw: s, detail: { shot: shot.index }, ...t });
  }
  return rows;
}

// ── Plain words for people ──────────────────────────────────────────────────────────────────────

export const STAGES = ["uploading", "queued", "preparing", "finding shots", "watching", "reading text", "listening", "describing shots", "saving", "placing on your map", "checking what it sells", "writing re-cuts", "ready"] as const;
export type Stage = (typeof STAGES)[number];

export const FAILURE = {
  refused: "We couldn't read this ad.",
  tooLong: (maxSeconds: number) => `This ad is longer than ${maxSeconds} seconds. Trim it and try again.`,
  unreadable: "We couldn't open this video. Try exporting it again as MP4.",
  missing: "The upload didn't finish. Try again.",
  busy: "Reading took too long. Try again.",
  failed: "Something went wrong while reading this ad. Try again; if it keeps happening, tell us with the feedback tab.",
  off: "Ad reading isn't set up yet.",
} as const;
