import { describe, expect, it } from "vitest";
import { PEOPLE_RULE } from "@/modules/adcheck/adcheck.shape";
import { applyChanges, type Change, type EditChange, fromShotNumbers, practiceRecuts, readOfRecut, recutPrompt, recutsSchema, type ShotContext, SHORTEST_MS, toEditList } from "@/modules/adcheck/recut";

const shot = (index: number, startMs: number, endMs: number, territory: ShotContext["territory"], cues: ShotContext["cues"] = []): ShotContext => ({ index, startMs, endMs, description: null, territory, cues });
// A 24-second draft, as Jude's summer draft was read: shot 3 pulls toward Ben & Jerry's.
const SHOTS: ShotContext[] = [
  shot(0, 0, 4000, null),
  shot(1, 4000, 8000, "YOURS", [{ cue: "carefree", territory: "YOURS", rival: null, tag: { name: "Carefree", type: "adjective:qloo" } }]),
  shot(2, 8000, 12000, "CONTESTED", [{ cue: "urban living", territory: "THEIRS", rival: "Häagen-Dazs" }, { cue: "romantic", territory: "YOURS", rival: null }]),
  shot(3, 12000, 16000, "THEIRS", [{ cue: "pool party", territory: "THEIRS", rival: "Ben & Jerry's", tag: { name: "Pool Parties", type: "lifestyle:qloo" } }, { cue: "playful", territory: "YOURS", rival: null }]),
  shot(4, 16000, 20000, "YOURS", [{ cue: "decadent", territory: "YOURS", rival: null }]),
  shot(5, 20000, 24000, "CONTESTED", [{ cue: "celebration", territory: "THEIRS", rival: "Ben & Jerry's" }, { cue: "playful", territory: "YOURS", rival: null }]),
];
const on = (c: Partial<Change> & Pick<Change, "op" | "shot">, i = 0): EditChange => ({ what: "x", why: "y", evidence: "", ...c, id: `c${i}`, on: true, proof: null });

describe("re-cuts: applying changes to the draft", () => {
  it("drops, trims and moves shots, and keeps the re-cut's own timeline", () => {
    const { clips, durationMs } = applyChanges(SHOTS, [on({ op: "drop", shot: 3 }), on({ op: "trim", shot: 0, startS: 1, endS: 3 }), on({ op: "move", shot: 4, position: "first" })], "Jude's");
    expect(clips.map((c) => c.shot)).toEqual([4, 0, 1, 2, 5]);
    expect(clips[1]).toMatchObject({ shot: 0, inMs: 1000, outMs: 3000 });
    expect(clips[0]!.moved).toBe(true);
    expect(durationMs).toBe(4000 + 2000 + 4000 * 3);
  });

  it("places captions over their shot in the new timeline, and the end card over the last clip", () => {
    const { overlays } = applyChanges(SHOTS, [on({ op: "move", shot: 4, position: "first" }), on({ op: "caption", shot: 1, text: "Summer, done properly" }), on({ op: "endcard", shot: 5, text: "Made properly" })], "Jude's");
    expect(overlays[0]).toMatchObject({ kind: "caption", text: "Summer, done properly", atMs: 8000 }); // shot 1 now starts after shots 4 and 0
    expect(overlays[1]).toMatchObject({ kind: "endCard", brand: "Jude's", line: "Made properly", untilMs: 24000 });
  });

  it("ignores switched-off changes and changes to shots that don't exist, and never empties the cut", () => {
    const off = { ...on({ op: "drop", shot: 1 }), on: false };
    expect(applyChanges(SHOTS, [off, on({ op: "drop", shot: 42 })], "J").clips).toHaveLength(6);
    expect(applyChanges(SHOTS, SHOTS.map((s, i) => on({ op: "drop", shot: s.index }, i)), "J").clips).toHaveLength(1);
  });

  it("keeps trims inside the shot and refuses slivers", () => {
    const { clips } = applyChanges(SHOTS, [on({ op: "trim", shot: 1, startS: 2, endS: 30 }), on({ op: "trim", shot: 2, startS: 9, endS: 9.2 })], "J");
    expect(clips.find((c) => c.shot === 1)).toMatchObject({ inMs: 4000, outMs: 8000 });
    expect(clips.find((c) => c.shot === 2)).toMatchObject({ inMs: 8000, outMs: 12000 });
  });
});

describe("re-cuts: from proposal to edit list", () => {
  it("never lists a change that wouldn't do anything", () => {
    const edit = toEditList(
      {
        kind: "RECOMMENDED", title: "R", summary: "s", newFootage: "",
        changes: [
          { op: "trim", shot: 2, what: "Trim the stroll", why: "w", evidence: "urban living" }, // no times (seen live)
          { op: "caption", shot: 1, text: " ", what: "Caption", why: "w", evidence: "" },
          { op: "move", shot: 1, position: "before", before: 99, what: "Move", why: "w", evidence: "" },
          { op: "drop", shot: 3, what: "Cut the pool party", why: "w", evidence: "pool party" },
        ],
      },
      SHOTS,
      "Jude's",
    );
    expect(edit.changes.map((c) => c.what)).toEqual(["Cut the pool party"]);
  });

  it("keeps words only on changes that put words on screen", () => {
    const edit = toEditList({ kind: "RECOMMENDED", title: "R", summary: "s", newFootage: "", changes: [{ op: "trim", shot: 2, startS: 8, endS: 10, text: "Sweet summer strolls", what: "Trim the stroll", why: "w", evidence: "" }] }, SHOTS, "Jude's");
    expect(edit.changes[0]!.text).toBeUndefined();
  });

  it("holds Shortest to 15 seconds, saying so as a change", () => {
    const edit = toEditList({ kind: "SHORTEST", title: "Shortest", summary: "s", newFootage: "", changes: [{ op: "drop", shot: 3, what: "Cut the pool", why: "w", evidence: "pool party" }] }, SHOTS, "Jude's");
    expect(edit.durationMs).toBeLessThanOrEqual(SHORTEST_MS + 250);
    expect(edit.changes.some((c) => c.evidence === "15 s limit")).toBe(true);
  });

  it("attaches the Qloo proof each change rests on, for the evidence tooltip", () => {
    const edit = toEditList(
      { kind: "RECOMMENDED", title: "R", summary: "s", newFootage: "", changes: [{ op: "drop", shot: 3, what: "Cut the pool party", why: "w", evidence: "pool party · leans toward Ben & Jerry's" }, { op: "move", shot: 1, position: "first", what: "Open on the park", why: "w", evidence: "leans your way" }] },
      SHOTS,
      "Jude's",
    );
    expect(edit.changes[0]!.proof).toMatchObject({ cue: "pool party", tag: { name: "Pool Parties" }, territory: "THEIRS", rival: "Ben & Jerry's", shot: 3 });
    expect(edit.changes[1]!.proof).toMatchObject({ cue: "carefree", territory: "YOURS" });
  });

  it("reads a re-cut from the shots it keeps: cutting what pulls away moves the lean", () => {
    const draft = readOfRecut(applyChanges(SHOTS, [], "J"), SHOTS);
    const recut = readOfRecut(applyChanges(SHOTS, [on({ op: "drop", shot: 3 }), on({ op: "drop", shot: 2 }, 1), on({ op: "drop", shot: 5 }, 2)], "J"), SHOTS);
    expect(draft.theirs.map((t) => t.cue)).toContain("pool party");
    expect(recut.theirs).toHaveLength(0);
    expect(recut.lean).toBe("yours");
  });
});

describe("re-cuts: asking Gemini", () => {
  it("turns Gemini's shot numbers (from 1) back into the draft's indexes", () => {
    const [r] = fromShotNumbers({ recuts: [{ kind: "BOLDEST", title: "B", summary: "s", newFootage: "", changes: [{ op: "move", shot: 5, position: "before", before: 1, what: "Open on shot 5", why: "w", evidence: "" }] }] }).recuts;
    expect(r!.changes[0]).toMatchObject({ shot: 4, before: 0 });
  });

  const ctx = { brand: "Jude's", rivals: ["Ben & Jerry's"], durationMs: 24000, shots: SHOTS, text: [{ text: "SUMMER, SCOOPED.", startMs: 4300, endMs: 7800 }], script: [], music: null, verdict: readOfRecut(applyChanges(SHOTS, [], "J"), SHOTS), placements: ["tiktok"] };

  it("gives Gemini every shot with where its cues lean, the words on screen and the people rule", () => {
    const p = recutPrompt(ctx);
    expect(p).toContain("pool party (leans toward Ben & Jerry's)");
    expect(p).toContain("Shot 4 · 12.0–16.0 s"); // numbered as the owner sees it: index 3 is shot 4
    expect(p).toContain('"SUMMER, SCOOPED."');
    expect(p).toContain(PEOPLE_RULE);
    expect(p.replace(PEOPLE_RULE, "")).not.toMatch(/\b(age|body|face|looks|skin|ethnic\w*)\b/i);
  });

  it("practice answers pass the schema and only touch real shots", () => {
    const answer = fromShotNumbers(recutsSchema.parse(practiceRecuts(ctx)));
    expect(answer.recuts.map((r) => r.kind)).toEqual(["RECOMMENDED", "SHORTEST", "BOLDEST"]);
    for (const r of answer.recuts) for (const c of r.changes) expect(SHOTS.some((s) => s.index === c.shot)).toBe(true);
  });
});

describe("re-cut: a version someone tweaked (R6) and its read (R7)", () => {
  const shots = [
    { index: 0, startMs: 0, endMs: 4000 },
    { index: 1, startMs: 4000, endMs: 9000 },
    { index: 2, startMs: 9000, endMs: 12000 },
  ];
  const base = { title: "Mine", format: "9:16" as const, sound: "original" as const, endCard: null };

  it("keeps clips inside their real shots, marks reordering, and times captions and the end card on the new timeline", async () => {
    const { editFromTweak } = await import("@/modules/adcheck/recut");
    const edit = editFromTweak({ ...base, endCard: "Fresh every morning", clips: [{ shot: 2, inMs: 8000, outMs: 12500, caption: { text: "Baked at six", position: "top" } }, { shot: 0, inMs: 500, outMs: 3500 }] }, shots, "GAIL's");
    if ("problem" in edit) throw new Error(edit.problem);
    expect(edit.clips.map((c) => [c.shot, c.inMs, c.outMs, c.moved])).toEqual([[2, 9000, 12000, false], [0, 500, 3500, true]]);
    expect(edit.durationMs).toBe(6000);
    expect(edit.overlays).toEqual([
      { kind: "caption", text: "Baked at six", atMs: 0, untilMs: 3000, position: "top" },
      { kind: "endCard", brand: "GAIL's", line: "Fresh every morning", atMs: 3000, untilMs: 6000 },
    ]);
  });

  it("refuses shots that don't exist or are cut too short, in words", async () => {
    const { editFromTweak } = await import("@/modules/adcheck/recut");
    expect(editFromTweak({ ...base, clips: [{ shot: 7, inMs: 0, outMs: 1000 }] }, shots, "x")).toEqual({ problem: "One of those shots isn't in the draft." });
    expect(editFromTweak({ ...base, clips: [{ shot: 1, inMs: 4000, outMs: 4200 }] }, shots, "x")).toMatchObject({ problem: expect.stringContaining("Shot 2 is too short") });
  });

  it("counts new caption words with the shot they sit over", async () => {
    const { readOfRecut } = await import("@/modules/adcheck/recut");
    const ctx = shots.map((s, i) => ({ ...s, description: null, territory: null, cues: i === 2 ? [{ cue: "pool party", territory: "THEIRS" as const, rival: "Pret" }] : [] }));
    const words = new Map([["Baked at six", { cue: "Baked at six", tag: null, judged: { territory: "YOURS" as const, rival: null, gap: 0.2 } }]]);
    const read = readOfRecut({ clips: [{ shot: 2, inMs: 9000, outMs: 12000, moved: false, caption: { text: "Baked at six", position: "top" } }] }, ctx, words);
    expect(read.yours.map((y) => [y.cue, y.shots])).toEqual([["baked at six", [2]]]);
    expect(read.theirs.map((t) => t.cue)).toEqual(["pool party"]);
  });
});
