import { z } from "zod";
import { PEOPLE_RULE, type ShotDescription } from "@/modules/adcheck/adcheck.shape";
import { type PlacedCue, type Verdict, verdictFrom } from "@/modules/adcheck/adcheck.verdict";

/**
 * Suggested re-cuts (Figma R5, spec §3.1). Pure; tested in tests/recut.test.ts.
 *
 * Gemini proposes *changes* to the draft (drop, trim, move, caption, end card), each with its reason
 * and evidence, from everything the check already knows: what each shot shows, where its cues land on
 * the map and against which rival, the words on screen and in the script, the verdict, where the ad
 * will run. The edit list itself is computed here from the draft's real shots, so a re-cut can only
 * use footage that exists, every change can be switched off without asking again, and Shortest is
 * held to 15 seconds by code rather than by hope.
 *
 * web/src/lib/recut.ts mirrors `applyChanges` so switches update the preview instantly; keep them in step.
 */

export const KINDS = ["RECOMMENDED", "SHORTEST", "BOLDEST"] as const;
export type RecutKind = (typeof KINDS)[number];
export const SHORTEST_MS = 15_000;
const MIN_CLIP_MS = 600;
const CAPTION_MS = 3_500;

const words = (max: number) => z.string().trim().min(1).max(max);

export const changeSchema = z.object({
  op: z.enum(["drop", "trim", "move", "caption", "endcard"]),
  /** The draft's shot the change is about, numbered from 1 as the owner sees it (see `fromShotNumbers`); for an end card, the shot it sits over (usually the last kept). */
  shot: z.number().int(),
  /** move: where the shot goes. "before" uses `before` (a draft shot number). */
  position: z.enum(["first", "last", "before"]).optional(),
  before: z.number().int().optional(),
  /** trim: the part of the shot to keep, in seconds from the start of the draft. */
  startS: z.number().optional(),
  endS: z.number().optional(),
  /** caption or end card wording. */
  text: z.string().trim().max(80).optional(),
  what: words(90),
  why: words(260),
  evidence: z.string().trim().max(90),
});
export type Change = z.infer<typeof changeSchema>;

export const recutSchema = z.object({
  kind: z.enum(KINDS),
  title: words(60),
  summary: words(320),
  changes: z.array(changeSchema).max(8),
  /** What no edit can fix and needs new footage; empty when nothing does. */
  newFootage: z.string().trim().max(260),
});
export const recutsSchema = z.object({ recuts: z.array(recutSchema).min(1).max(3) });
export type RecutProposal = z.infer<typeof recutSchema>;

/* ------------------------------------------------------------- context */

type Label = "YOURS" | "CONTESTED" | "THEIRS" | null;
export type ShotContext = {
  index: number;
  startMs: number;
  endMs: number;
  description: ShotDescription | null;
  territory: Label;
  cues: { cue: string; territory: Label; rival: string | null; tag?: { name: string; type: string } | null }[];
};
export type RecutContext = {
  brand: string;
  rivals: string[];
  durationMs: number;
  shots: ShotContext[];
  text: { text: string; startMs: number; endMs: number }[];
  script: { words: string; speaker: string; startMs: number; endMs: number }[];
  music: string | null;
  verdict: Verdict;
  placements: string[];
};

const s = (ms: number) => (ms / 1000).toFixed(1);
const where = (t: Label, rival: string | null) => (t === "YOURS" ? "leans your way" : t === "THEIRS" ? `leans toward ${rival ?? "a rival"}` : t === "CONTESTED" ? `shared with ${rival ?? "a rival"}` : "no read");

export function recutPrompt(c: RecutContext) {
  const shots = c.shots.map((sh) => {
    const d = sh.description;
    const cues = sh.cues.map((q) => `${q.cue} (${where(q.territory, q.rival)})`).join("; ");
    return `Shot ${sh.index + 1} · ${s(sh.startMs)}–${s(sh.endMs)} s · ${d ? `${d.action} Setting: ${d.setting}. Mood: ${d.mood}.` : "not described"} · overall: ${where(sh.territory, null).replace("a rival", "rivals")}${cues ? ` · cues: ${cues}` : ""}`;
  });
  return [
    `You are an ad editor for ${c.brand}, a brand whose rivals are ${c.rivals.join(" and ") || "unknown"}.`,
    `Below is a draft ad (${s(c.durationMs)} s) as our system read it: each shot, and where its cultural cues land on ${c.brand}'s Culture Map (which is built from what its customers watch, follow and visit).`,
    "",
    "SHOTS",
    ...shots,
    "",
    "ON-SCREEN TEXT",
    ...(c.text.length ? c.text.map((t) => `${s(t.startMs)}–${s(t.endMs)} s: "${t.text}"`) : ["none"]),
    "",
    "SCRIPT",
    ...(c.script.length ? c.script.map((l) => `${s(l.startMs)}–${s(l.endMs)} s, ${l.speaker}: "${l.words}"`) : ["no speech"]),
    `MUSIC: ${c.music ?? "none"}`,
    `RUNS ON: ${c.placements.length ? c.placements.join(", ") : "not said"}`,
    "",
    `THE READ: ${c.verdict.headline}`,
    ...c.verdict.reshoot.map((r) => `- ${r}`),
    "",
    "Write three re-cuts of THIS footage, as changes to the draft:",
    `- RECOMMENDED: the best version for ${c.brand}'s customers; keep what works, fix what pulls toward a rival.`,
    `- SHORTEST: a cut-down of at most 15 seconds for feeds, keeping the moments that lean ${c.brand}'s way.`,
    `- BOLDEST: lean as hard as the footage allows into ${c.brand}'s own ground, even if it changes the story.`,
    "",
    "Changes you can make (shot numbers are the draft's, counted from 1 as listed; use them in `shot`, `before` and your wording):",
    "- drop: cut a shot.",
    "- trim: keep only startS–endS of a shot (seconds in the draft, inside that shot).",
    '- move: place a shot "first", "last", or "before" another shot.',
    "- caption: a short line (at most 6 words) shown over a shot, in the brand's voice, drawn from what leans its way. You cannot remove text that is burned into the footage.",
    "- endcard: a closing line over the last kept shot (the brand name is added for you).",
    "Rules: use only the shots listed; never invent footage. At most 6 changes per re-cut. Each change says what it does and why in one plain sentence, citing where things lean (no scores or numbers), and gives short evidence (for example \"pool party · leans toward Ben & Jerry's\"). If a problem can only be fixed with new footage, say so in newFootage; otherwise leave it empty.",
    PEOPLE_RULE,
    "Answer only with JSON that matches the schema.",
  ].join("\n");
}

/** Practice mode: three plausible re-cuts from the shots' real territories, schema-valid. */
export function practiceRecuts(c: Pick<RecutContext, "brand" | "shots">) {
  const theirs = c.shots.filter((sh) => sh.territory === "THEIRS");
  const yours = c.shots.filter((sh) => sh.territory === "YOURS");
  const last = (c.shots.at(-1)?.index ?? 0) + 1;
  const drops: Change[] = theirs.map((sh) => ({ op: "drop", shot: sh.index + 1, what: `Cut shot ${sh.index + 1}`, why: `It pulls toward ${sh.cues.find((q) => q.territory === "THEIRS")?.rival ?? "a rival"}.`, evidence: sh.cues.find((q) => q.territory === "THEIRS")?.cue ?? "leans to a rival" }));
  const open: Change[] = yours[0] && yours[0].index !== 0 ? [{ op: "move", shot: yours[0].index + 1, position: "first", what: `Open on shot ${yours[0].index + 1}`, why: "It's the moment that leans most your way.", evidence: yours[0].cues[0]?.cue ?? "leans your way" }] : [];
  const end: Change = { op: "endcard", shot: last, text: "Made properly", what: "End on your name", why: "Finishes on the brand rather than a rival's mood.", evidence: "end card" };
  return {
    recuts: [
      { kind: "RECOMMENDED" as const, title: "Recommended", summary: `Keeps the draft's best moments for ${c.brand}'s customers and cuts what pulls away.`, changes: [...open, ...drops, end], newFootage: "" },
      { kind: "SHORTEST" as const, title: "Shortest · 15 s", summary: "A cut-down for feeds that keeps the moments that lean your way.", changes: [...drops, end], newFootage: "" },
      { kind: "BOLDEST" as const, title: "Boldest", summary: "Only the shots that lean your way, in their strongest order.", changes: [...c.shots.filter((sh) => sh.territory !== "YOURS" && sh.index + 1 !== last).map((sh): Change => ({ op: "drop", shot: sh.index + 1, what: `Cut shot ${sh.index + 1}`, why: "It isn't clearly yours.", evidence: sh.territory ? sh.territory.toLowerCase() : "no read" })), ...open, end], newFootage: "" },
    ],
  };
}

/** Gemini and practice number shots from 1, as the owner sees them; the edit list uses the draft's indexes. */
export function fromShotNumbers(answer: z.infer<typeof recutsSchema>) {
  return { recuts: answer.recuts.map((r) => ({ ...r, changes: r.changes.map((c) => ({ ...c, shot: c.shot - 1, before: c.before === undefined ? undefined : c.before - 1 })) })) };
}

/* ----------------------------------------------------------- edit list */

export type Position = "top" | "middle" | "bottom";
export type Format = "9:16" | "16:9" | "1:1";
/** A clip of the draft. `cropX`/`cropY` (0–1) say where the frame sits when cropped to another shape; `caption` is a tweak's own line over it. */
export type Clip = { shot: number; inMs: number; outMs: number; moved: boolean; cropX?: number; cropY?: number; caption?: { text: string; position: Position } };
export type Overlay = { kind: "caption"; text: string; atMs: number; untilMs: number; position?: Position } | { kind: "endCard"; brand: string; line: string; atMs: number; untilMs: number };
/** What a change rests on, for the evidence tooltip: the cue, the Qloo tag it matched, where it leans. */
export type Proof = { cue: string; tag: { name: string; type: string } | null; territory: Label; rival: string | null; shot: number };
export type EditChange = Change & { id: string; on: boolean; proof: Proof | null };
export type EditList = {
  version: 1;
  kind: RecutKind;
  title: string;
  summary: string;
  newFootage: string;
  changes: EditChange[];
  clips: Clip[];
  overlays: Overlay[];
  durationMs: number;
  /** A tweaked version (R6) records its shape and sound; suggested re-cuts leave them out. */
  format?: Format;
  sound?: "original" | "mute";
  endCard?: string | null;
};

/**
 * Apply the switched-on changes to the draft's shots, in a fixed order (drops, trims, moves, then
 * captions and the end card over the result). Changes that point at shots that don't exist are
 * ignored. A re-cut always keeps at least one shot.
 */
export function applyChanges(shots: Pick<ShotContext, "index" | "startMs" | "endMs">[], changes: EditChange[], brand: string) {
  const on = changes.filter((c) => c.on);
  const known = new Map(shots.map((s) => [s.index, s]));
  const dropped = new Set(on.filter((c) => c.op === "drop" && known.has(c.shot)).map((c) => c.shot));
  if (dropped.size >= shots.length) dropped.delete(shots[0]!.index);
  let clips: Clip[] = shots.filter((s) => !dropped.has(s.index)).map((s) => ({ shot: s.index, inMs: s.startMs, outMs: s.endMs, moved: false }));

  for (const c of on.filter((c) => c.op === "trim")) {
    const clip = clips.find((k) => k.shot === c.shot);
    if (!clip || c.startS === undefined || c.endS === undefined) continue;
    const inMs = Math.max(clip.inMs, Math.round(c.startS * 1000));
    const outMs = Math.min(clip.outMs, Math.round(c.endS * 1000));
    if (outMs - inMs >= MIN_CLIP_MS) Object.assign(clip, { inMs, outMs });
  }
  for (const c of on.filter((c) => c.op === "move")) {
    const i = clips.findIndex((k) => k.shot === c.shot);
    if (i < 0) continue;
    const [clip] = clips.splice(i, 1);
    clip!.moved = true;
    let to = clips.length; // "last", or "before" a shot that isn't in the cut
    if (c.position === "first") to = 0;
    else if (c.position === "before") {
      const j = clips.findIndex((k) => k.shot === c.before);
      if (j >= 0) to = j;
    }
    clips.splice(to, 0, clip!);
  }

  // Where each clip lands in the re-cut's own timeline.
  let t = 0;
  const at = new Map<number, { start: number; end: number }>();
  for (const k of clips) {
    at.set(k.shot, { start: t, end: t + (k.outMs - k.inMs) });
    t += k.outMs - k.inMs;
  }
  const overlays: Overlay[] = [];
  for (const c of on.filter((c) => c.op === "caption" && c.text)) {
    const span = at.get(c.shot);
    if (span) overlays.push({ kind: "caption", text: c.text!, atMs: span.start, untilMs: Math.min(span.end, span.start + CAPTION_MS) });
  }
  const end = on.find((c) => c.op === "endcard");
  if (end && clips.length) {
    const last = at.get(clips.at(-1)!.shot)!;
    overlays.push({ kind: "endCard", brand, line: end.text ?? "", atMs: Math.max(last.start, last.end - 3_000), untilMs: last.end });
  }
  clips = clips.map((k) => ({ ...k }));
  return { clips, overlays, durationMs: t };
}

/**
 * Shortest must fit: if the switched-on changes still run long, trim every kept clip by the same share
 * (never below MIN_CLIP_MS), and say so as a change of its own.
 */
export function fitShortest(shots: ShotContext[], changes: EditChange[], brand: string): EditChange[] {
  const { clips, durationMs } = applyChanges(shots, changes, brand);
  if (durationMs <= SHORTEST_MS + 250) return changes;
  const share = SHORTEST_MS / durationMs;
  const trims: EditChange[] = clips.map((k, i) => {
    const keep = Math.max(MIN_CLIP_MS, Math.floor((k.outMs - k.inMs) * share));
    return { id: `fit-${i}`, on: true, op: "trim", shot: k.shot, startS: k.inMs / 1000, endS: (k.inMs + keep) / 1000, what: `Shorten shot ${k.shot + 1}`, why: "Brings the cut-down to 15 seconds for feeds.", evidence: "15 s limit", proof: null };
  });
  return [...changes.filter((c) => c.op !== "trim" || !clips.some((k) => k.shot === c.shot)), ...trims];
}

/**
 * The cue a change rests on: the one its evidence names, else the shot's clearest cue that fits the
 * change (a cut rests on what pulls away, a move or caption on what leans your way).
 */
export function proofOf(c: Change, shots: ShotContext[]): Proof | null {
  const shot = shots.find((s) => s.index === c.shot);
  if (!shot?.cues.length) return null;
  const ev = c.evidence.toLowerCase();
  const named = shot.cues.find((q) => ev.includes(q.cue.toLowerCase()));
  const want = c.op === "drop" ? ["THEIRS", "CONTESTED"] : ["YOURS"];
  const q = named ?? shot.cues.find((x) => x.territory && want.includes(x.territory));
  return q ? { cue: q.cue, tag: q.tag ?? null, territory: q.territory, rival: q.rival, shot: shot.index } : null;
}

/**
 * Whether a change would do anything. A switch must never list an edit that isn't made: a trim with
 * no times (Gemini sent one, 26 Oct), a caption with no words, a move with nowhere to go.
 */
export function doesSomething(c: Change, shots: Pick<ShotContext, "index" | "startMs" | "endMs">[]) {
  if (c.op === "endcard") return true;
  const shot = shots.find((s) => s.index === c.shot);
  if (!shot) return false;
  if (c.op === "trim") {
    if (c.startS === undefined || c.endS === undefined) return false;
    const inMs = Math.max(shot.startMs, c.startS * 1000);
    const outMs = Math.min(shot.endMs, c.endS * 1000);
    return outMs - inMs >= MIN_CLIP_MS && (inMs > shot.startMs + 50 || outMs < shot.endMs - 50);
  }
  if (c.op === "caption") return Boolean(c.text?.trim());
  if (c.op === "move") return c.position === "first" || c.position === "last" || (c.position === "before" && shots.some((s) => s.index === c.before && s.index !== c.shot));
  return true;
}

export function toEditList(p: RecutProposal, shots: ShotContext[], brand: string): EditList {
  let changes: EditChange[] = p.changes
    .filter((c) => doesSomething(c, shots))
    .map((c, i) => ({ ...c, text: c.op === "caption" || c.op === "endcard" ? c.text : undefined, id: `c${i + 1}`, on: true, proof: c.op === "endcard" ? null : proofOf(c, shots) }));
  if (p.kind === "SHORTEST") changes = fitShortest(shots, changes, brand);
  const { clips, overlays, durationMs } = applyChanges(shots, changes, brand);
  return { version: 1, kind: p.kind, title: p.title, summary: p.summary, newFootage: p.newFootage, changes, clips, overlays, durationMs };
}

/* ------------------------------------------------- a tweaked version (R6) */

export const MAX_CLIPS = 30;
export const tweakSchema = z.object({
  title: z.string().trim().min(1).max(60).default("Your version"),
  format: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  sound: z.enum(["original", "mute"]).default("original"),
  endCard: z.string().trim().max(80).nullable().default(null),
  clips: z
    .array(
      z.object({
        shot: z.number().int().min(0),
        inMs: z.number().int().min(0),
        outMs: z.number().int().min(1),
        cropX: z.number().min(0).max(1).optional(),
        cropY: z.number().min(0).max(1).optional(),
        caption: z.object({ text: z.string().trim().min(1).max(80), position: z.enum(["top", "middle", "bottom"]) }).optional(),
      }),
    )
    .min(1, "Keep at least one shot.")
    .max(MAX_CLIPS),
});
export type Tweak = z.infer<typeof tweakSchema>;

/**
 * A version the person edited, as an edit list the players and export read. Every clip must sit inside
 * a real shot of the draft and last at least MIN_CLIP_MS; anything else is refused, never guessed at.
 * A caption lasts its whole clip; the end card is the last 3 seconds.
 */
export function editFromTweak(t: Tweak, shots: Pick<ShotContext, "index" | "startMs" | "endMs">[], brand: string): EditList | { problem: string } {
  const byIndex = new Map(shots.map((s) => [s.index, s]));
  const clips: Clip[] = [];
  for (const c of t.clips) {
    const shot = byIndex.get(c.shot);
    if (!shot) return { problem: "One of those shots isn't in the draft." };
    const inMs = Math.max(shot.startMs, c.inMs);
    const outMs = Math.min(shot.endMs, c.outMs);
    if (outMs - inMs < MIN_CLIP_MS) return { problem: `Shot ${c.shot + 1} is too short to keep: make it at least ${MIN_CLIP_MS / 1000} s or remove it.` };
    clips.push({ shot: c.shot, inMs, outMs, moved: false, ...(c.cropX !== undefined ? { cropX: c.cropX } : {}), ...(c.cropY !== undefined ? { cropY: c.cropY } : {}), ...(c.caption ? { caption: c.caption } : {}) });
  }
  // "moved" marks clips out of the draft's order, for the shot strip.
  let last = -1;
  for (const k of clips) {
    if (k.shot < last) k.moved = true;
    last = Math.max(last, k.shot);
  }
  const overlays: Overlay[] = [];
  let at = 0;
  for (const k of clips) {
    const len = k.outMs - k.inMs;
    if (k.caption) overlays.push({ kind: "caption", text: k.caption.text, atMs: at, untilMs: at + len, position: k.caption.position });
    at += len;
  }
  if (t.endCard) overlays.push({ kind: "endCard", brand, line: t.endCard, atMs: Math.max(0, at - 3_000), untilMs: at });
  return { version: 1, kind: "RECOMMENDED", title: t.title, summary: "", newFootage: "", changes: [], clips, overlays, durationMs: at, format: t.format, sound: t.sound, endCard: t.endCard };
}

/** New words a version adds (its captions and end card), to place on the map. */
export function wordsOf(edit: Pick<EditList, "clips" | "endCard">) {
  return [...new Set([...edit.clips.flatMap((c) => (c.caption ? [c.caption.text] : [])), ...(edit.endCard ? [edit.endCard] : [])].map((w) => w.trim()).filter(Boolean))];
}

/* ---------------------------------------------------------- the read */

/**
 * Where a re-cut lands, from the same Qloo evidence as the draft: only the cues of the shots it keeps.
 * New captions aren't placed yet (that's "Check again", R7).
 */
export function readOfRecut(edit: Pick<EditList, "clips">, shots: ShotContext[], words: Map<string, PlacedCue> = new Map()): Verdict {
  const kept = new Set(edit.clips.map((c) => c.shot));
  const placed = new Map<string, PlacedCue>();
  const shotCues: { index: number; cues: string[] }[] = [];
  for (const sh of shots.filter((s) => kept.has(s.index))) {
    // A caption over a shot counts with that shot's own cues ("Check again", R7).
    const said = edit.clips.filter((c) => c.shot === sh.index && c.caption).map((c) => c.caption!.text.trim());
    shotCues.push({ index: sh.index, cues: [...sh.cues.map((q) => q.cue), ...said.map((w) => w.toLowerCase())] });
    for (const q of sh.cues) {
      if (!placed.has(q.cue)) placed.set(q.cue, { cue: q.cue, tag: null, judged: q.territory ? { territory: q.territory, rival: q.rival, gap: 0.1 } : null });
    }
  }
  for (const [w, p] of words) if (!placed.has(w.toLowerCase())) placed.set(w.toLowerCase(), { ...p, cue: w.toLowerCase() });
  return verdictFrom(placed, shotCues);
}

/** The draft's shots as the re-cut writer and the checker read them, from saved rows. */
export function toShotContexts(rows: { index: number; startMs: number; endMs: number; description: unknown; territory: Label; evidence: unknown }[], parse: (d: unknown) => ShotDescription | null): ShotContext[] {
  return rows.map((sh) => ({
    index: sh.index,
    startMs: sh.startMs,
    endMs: sh.endMs,
    description: sh.description ? parse(sh.description) : null,
    territory: sh.territory,
    cues: ((sh.evidence as { cues?: { cue: string; territory: Label; rival: string | null; tag?: { name: string; type: string } | null }[] } | null)?.cues ?? []).map((q) => ({ cue: q.cue, territory: q.territory, rival: q.rival, tag: q.tag ? { name: q.tag.name, type: q.tag.type } : null })),
  }));
}
