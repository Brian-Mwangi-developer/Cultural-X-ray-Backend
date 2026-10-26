import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put } from "@vercel/blob/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmailVerificationToken } from "better-auth/api";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { connectRedis, disconnectRedis } from "@/infra/redis";
import { rabbitmq } from "@/infra/rabbitmq";
import { assertTopology } from "@/messaging/topology";
import { Outcome } from "@/messaging/types";
import { cutsFromShowinfo, elementsFrom, PEOPLE_RULE, practice, prompts, shotsFrom, MAX_SHOTS } from "@/modules/adcheck/adcheck.shape";
import { AD_CHECK, adCheckHandlers } from "@/modules/adcheck/adcheck.queue";
import { placeCues, qlooEnabled } from "@/modules/adcheck/adcheck.place";
import { clearest, cuesPrompt, judge, uniqueCues, verdictFrom } from "@/modules/adcheck/adcheck.verdict";
import { describe as describeBlob, uploadedPath, videoPath } from "@/modules/adcheck/storage";
import { startTestServer, waitFor } from "./helpers";

describe("ad check: shots", () => {
  it("reads cut times from ffmpeg's showinfo log", () => {
    const log = "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  50176 pts_time:1.96     duration: 512\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 102400 pts_time:4.0 duration: 512";
    expect(cutsFromShowinfo(log)).toEqual([1960, 4000]);
  });

  it("turns cuts into shots, folding flashes into the shot before", () => {
    expect(shotsFrom([2000, 2200, 4000], 6000)).toEqual([
      { index: 0, startMs: 0, endMs: 2000 },
      { index: 1, startMs: 2000, endMs: 4000 },
      { index: 2, startMs: 4000, endMs: 6000 },
    ]);
    expect(shotsFrom([5900], 6000)).toEqual([{ index: 0, startMs: 0, endMs: 6000 }]);
    expect(shotsFrom([], 300)).toEqual([{ index: 0, startMs: 0, endMs: 300 }]);
    expect(shotsFrom([-5, 0, 9000], 6000)).toEqual([{ index: 0, startMs: 0, endMs: 6000 }]);
  });

  it("never sends more than 40 shots, and still covers the whole ad", () => {
    const cuts = Array.from({ length: 99 }, (_, i) => (i + 1) * 600);
    const shots = shotsFrom(cuts, 60_000);
    expect(shots.length).toBe(MAX_SHOTS);
    expect(shots[0]?.startMs).toBe(0);
    expect(shots.at(-1)?.endMs).toBe(60_000);
    for (let i = 1; i < shots.length; i++) expect(shots[i]?.startMs).toBe(shots[i - 1]?.endMs);
  });
});

describe("ad check: the people rule", () => {
  const cues = cuesPrompt(practice.context, [{ index: 0, description: practice.shot(0) }], "acoustic folk");
  const all = [prompts.context(), prompts.text(), prompts.audio(), prompts.shot(0, 3, 0, 2, practice.context), cues];

  it("is in every prompt that can see or hear people", () => {
    for (const p of [all[0], all[2], all[3], all[4]]) expect(p).toContain(PEOPLE_RULE);
  });

  it("no prompt asks about age, body, face or looks outside the rule itself", () => {
    for (const p of all) expect(p!.replace(PEOPLE_RULE, "")).not.toMatch(/\b(age|ages|aged|old|young|child|children|kid's look|body|bodies|face|faces|looks?|attractive|skin|ethnic\w*|race|gender|hair)\b/i);
  });
});

describe("ad check: answers to elements", () => {
  it("saves settings, text, speech, music and styling with times inside the ad", () => {
    const shots = [{ index: 0, startMs: 0, endMs: 2000 }, { index: 1, startMs: 2000, endMs: 4000 }];
    const rows = elementsFrom(
      4000,
      practice.context,
      { items: [{ text: "Late", startS: 3.5, endS: 9, kind: "headline" }] },
      practice.audio,
      shots.map((shot) => ({ shot, description: practice.shot(shot.index) })),
    );
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ["SETTING", "ONSCREEN_TEXT", "SCRIPT", "SOUND", "STYLING", "LOGO"]) expect(kinds.has(k as never)).toBe(true);
    expect(rows.find((r) => r.raw === "Late")).toMatchObject({ startMs: 3500, endMs: 4000 });
    expect(rows.every((r) => r.startMs >= 0 && r.endMs <= 4000 && r.endMs >= r.startMs)).toBe(true);
  });
});

describe("ad check: placing cues", () => {
  const FILLER = 0.7649962877984056;
  const side = { you: ["judes", "tonys"], rivals: [{ id: "bj", name: "Ben & Jerry's" }, { id: "hd", name: "Häagen-Dazs" }] };
  const scores = (o: Record<string, number>) => new Map(Object.entries(o));

  it("ignores Qloo's filler and says nothing when no brand has a real score", () => {
    expect(judge(scores({ judes: FILLER, bj: FILLER, hd: FILLER }), side)).toBeNull();
    expect(judge(scores({ judes: FILLER, bj: 0.95 }), side)).toMatchObject({ territory: "THEIRS", rival: "Ben & Jerry's" });
  });

  it("counts the brands your customers also buy as your side, and calls close gaps shared", () => {
    expect(judge(scores({ judes: 0.8, tonys: 0.95, bj: 0.88 }), side)).toMatchObject({ territory: "YOURS" });
    expect(judge(scores({ judes: 0.9, bj: 0.91, hd: 0.7 }), side)).toMatchObject({ territory: "CONTESTED", rival: "Ben & Jerry's" });
    expect(judge(scores({ judes: 0.8, bj: 0.85, hd: 0.94 }), side)).toMatchObject({ territory: "THEIRS", rival: "Häagen-Dazs" });
  });

  it("prefers the tag where one side is clearly ahead", () => {
    const pick = clearest([
      { name: "a", judged: { territory: "CONTESTED" as const, rival: "x", gap: 0.02 } },
      { name: "b", judged: null },
      { name: "c", judged: { territory: "YOURS" as const, rival: null, gap: 0.05 } },
    ]);
    expect(pick?.name).toBe("c");
  });

  it("cleans and de-duplicates cues", () => {
    expect(uniqueCues({ shots: [{ index: 0, cues: ["Cozy", "family  dinner"] }, { index: 1, cues: ["cozy"] }], whole: ["Playful"] })).toEqual(["cozy", "family dinner", "playful"]);
  });
});

describe("ad check: the verdict in words", () => {
  const placed = (entries: [string, "YOURS" | "THEIRS" | "CONTESTED" | null, string | null][]) =>
    new Map(entries.map(([cue, territory, rival]) => [cue, { cue, tag: null, judged: territory ? { territory, rival, gap: 0.1 } : null }]));
  const shots = [{ index: 0, cues: ["cozy", "playful"] }, { index: 1, cues: ["cozy", "skateboarding"] }, { index: 2, cues: ["dog walking"] }];

  it("reads as yours when your cues outweigh theirs", () => {
    const v = verdictFrom(placed([["cozy", "YOURS", null], ["playful", "YOURS", null], ["skateboarding", "THEIRS", "Ben & Jerry's"], ["dog walking", null, null]]), shots);
    expect(v.lean).toBe("yours");
    expect(v.headline).toBe("This ad reads as yours: cozy and playful are what your customers are into.");
    expect(v.reshoot).toEqual(['Shot 2: "skateboarding" pulls toward Ben & Jerry\'s.']);
    expect(v.notes[0]).toBe("Qloo has no read on dog walking.");
  });

  it("names the rival an ad leans toward", () => {
    const v = verdictFrom(placed([["cozy", "THEIRS", "Häagen-Dazs"], ["playful", "THEIRS", "Häagen-Dazs"], ["skateboarding", "YOURS", null]]), shots);
    expect(v).toMatchObject({ lean: "theirs", rival: "Häagen-Dazs" });
    expect(v.headline).toContain("leans toward Häagen-Dazs");
  });

  it("describes named references without doubling a brand's possessive", () => {
    const v = verdictFrom(placed([["cozy", "YOURS", null]]), shots, [
      { name: "Ben & Jerry's", territory: "THEIRS", rival: "Ben & Jerry's" },
      { name: "Glastonbury", territory: "THEIRS", rival: "Ben & Jerry's" },
      { name: "Bath", territory: "YOURS", rival: null },
      { name: "Paris", territory: null, rival: null },
    ]);
    expect(v.references.map((r) => r.says)).toEqual(["your rival", "closer to Ben & Jerry's", "yours", "not on your map"]);
  });

  it("is honest when Qloo has nothing to go on, and never shows a score", () => {
    const v = verdictFrom(placed([["dog walking", null, null]]), shots);
    expect(v.lean).toBe("unclear");
    for (const text of [v.headline, ...v.notes]) expect(text).not.toMatch(/\d|%/);
  });
});

describe.skipIf(!qlooEnabled())("ad check: placing on a real map (Qloo)", () => {
  it("places cues for Jude's against Ben & Jerry's and Häagen-Dazs", async () => {
    const side = {
      you: ["A7E5D953-CC71-4A14-9424-5C8195835048", "6B62EE34-63B6-45EB-B4D0-002EB0455D16", "010427F3-38F8-4F64-8417-E4CE4C9AF209"],
      rivals: [{ id: "860395D4-48E2-4B47-991F-50109D19D6FC", name: "Ben & Jerry's" }, { id: "8C3F520D-D32C-482B-BD41-C291108E0297", name: "Häagen-Dazs" }],
    };
    const adId = `test-place-${randomUUID().slice(0, 8)}`;
    const placed = await placeCues(["cozy", "skateboarding"], side, { feature: "AD_CHECK", adId });
    expect(placed.get("cozy")?.judged?.territory).toBe("YOURS");
    expect(placed.get("skateboarding")?.judged).toMatchObject({ territory: "THEIRS", rival: "Ben & Jerry's" });
    expect(await prisma.aiCall.count({ where: { adId, provider: "qloo" } })).toBe(2);
    await prisma.aiCall.deleteMany({ where: { adId } });
  }, 180_000);
});

// ── Routes and the worker, end to end (practice Gemini, real Vercel Blob) ───────────────────────

const run = randomUUID().slice(0, 8);
const origin = config.http.webOrigins[0] ?? "http://localhost:3000";
const emails = { owner: `adowner+${run}@xray.test`, viewer: `adviewer+${run}@xray.test` };
const cookies: Record<string, string> = {};
let server: Awaited<ReturnType<typeof startTestServer>>;
let workspaceId = "";
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const endToEnd = Boolean(config.blob.token) && config.gemini.provider === "practice" && hasFfmpeg;

async function verifiedSession(email: string, name: string) {
  await fetch(`${server.url}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ name, email, password: "culture-map-2026" }) });
  const token = await createEmailVerificationToken(config.auth.secret, email);
  const res = await fetch(`${server.url}/api/auth/verify-email?token=${token}`, { redirect: "manual" });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const call = (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.url}${path}`, { method, headers: { "content-type": "application/json", origin, cookie: cookies[who] ?? "", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Three 2-second scenes with a tone: three shots. */
function makeClip() {
  const dir = mkdtempSync(join(tmpdir(), "adcheck-test-"));
  const file = join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=2",
    "-f", "lavfi", "-i", "color=c=red:size=640x360:rate=25:duration=2",
    "-f", "lavfi", "-i", "mandelbrot=size=640x360:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-filter_complex", "[2:v]trim=duration=2,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", file,
  ]);
  const bytes = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

beforeAll(async () => {
  await connectRedis();
  await rabbitmq.connect();
  await assertTopology(rabbitmq.channel(), () => rabbitmq.replacePublishChannel());
  server = await startTestServer();
  cookies.owner = await verifiedSession(emails.owner, "Ada Mensah");
  cookies.viewer = await verifiedSession(emails.viewer, "Leo Park");
  const org = await call("owner", "POST", "/api/auth/organization/create", { name: "Kettle Lane", slug: `kl${run}`, kind: "WORKSPACE" });
  workspaceId = ((await org.json()) as { id: string }).id;
  const viewer = await prisma.user.findUniqueOrThrow({ where: { email: emails.viewer } });
  await prisma.member.create({ data: { id: randomUUID(), organizationId: workspaceId, userId: viewer.id, role: "viewer" } });
});

afterAll(async () => {
  // Any video still in Blob is deleted through the API, the way people do it.
  const left = await prisma.ad.findMany({ where: { workspaceId, videoDeletedAt: null }, select: { id: true } });
  for (const ad of left) await call("owner", "DELETE", `/api/v1/orgs/${workspaceId}/ads/${ad.id}`);
  await prisma.aiCall.deleteMany({ where: { workspaceId } });
  await prisma.organization.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await server.close();
  await rabbitmq.close();
  await disconnectRedis();
  await prisma.$disconnect();
});

describe("ad check: routes", () => {
  it("keeps upload paths inside the workspace and the ad", () => {
    expect(videoPath("ws1", "ad1", "../../Summer Ad (final) v2.MOV")).toBe("ads/ws1/ad1/Summer-Ad-final-v2.mov");
  });

  it("only accepts an uploaded path inside the one it handed out", () => {
    const given = "ads/ws1/ad1/summer.mp4";
    expect(uploadedPath(given, undefined)).toBe(given);
    expect(uploadedPath(given, "ads/ws1/ad1/summer-Xy12AbCd.mp4")).toBe("ads/ws1/ad1/summer-Xy12AbCd.mp4");
    expect(uploadedPath(given, "ads/ws1/ad2/summer.mp4")).toBeNull();
    expect(uploadedPath(given, "ads/ws1/ad1/summer/../../x.mp4")).toBeNull();
  });

  it("refuses viewers, wrong types and oversized files before any upload", async () => {
    const path = `/api/v1/orgs/${workspaceId}/ads`;
    expect((await call("viewer", "POST", path, { fileName: "a.mp4", sizeBytes: 1000, contentType: "video/mp4" })).status).toBe(403);
    if (!config.blob.token) return;
    expect((await call("owner", "POST", path, { fileName: "a.gif", sizeBytes: 1000, contentType: "image/gif" })).status).toBe(400);
    expect((await call("owner", "POST", path, { fileName: "a.mp4", sizeBytes: config.adCheck.maxBytes + 1, contentType: "video/mp4" })).status).toBe(400);
  });

  it("won't start a check whose upload never arrived", async () => {
    if (!config.blob.token) return;
    const created = (await (await call("owner", "POST", `/api/v1/orgs/${workspaceId}/ads`, { fileName: "never.mp4", sizeBytes: 1000, contentType: "video/mp4" })).json()) as { adId: string };
    const res = await call("owner", "POST", `/api/v1/orgs/${workspaceId}/ads/${created.adId}/start`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("The upload didn't finish. Try again.");
    expect((await call("owner", "GET", `/api/v1/orgs/${workspaceId}/ads`)).ok).toBe(true);
  });
});

describe.skipIf(!endToEnd)("ad check: upload, read, play, delete", () => {
  let adId = "";

  it("uploads straight to Blob with the client token and starts reading", async () => {
    const clip = makeClip();
    const created = await call("owner", "POST", `/api/v1/orgs/${workspaceId}/ads`, { fileName: "Kettle Lane 6s.mp4", sizeBytes: clip.length, contentType: "video/mp4" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { adId: string; pathname: string; clientToken: string; access: "private" | "public" };
    adId = body.adId;
    const uploaded = await put(body.pathname, clip, { access: body.access, token: body.clientToken, contentType: "video/mp4" });

    const start = await call("owner", "POST", `/api/v1/orgs/${workspaceId}/ads/${adId}/start`, { pathname: uploaded.pathname, placements: ["reels"], rivals: [] });
    expect(start.status).toBe(202);
    expect((await prisma.ad.findUniqueOrThrow({ where: { id: adId } })).status).toBe("QUEUED");
  });

  it("reads it in the worker: three shots described, elements saved, every call costed", async () => {
    const envelope = { id: randomUUID(), type: AD_CHECK, payload: { adId }, createdAt: new Date().toISOString(), attempt: 1 };
    // A running dev worker may take the queued job first; then wait for it instead.
    if ((await adCheckHandlers[AD_CHECK]!.handle({ adId }, envelope)) === Outcome.Skipped) {
      await waitFor(async () => (await prisma.ad.findUnique({ where: { id: adId } }))?.status === "READY", 60_000, 500);
    }

    const res = await call("viewer", "GET", `/api/v1/orgs/${workspaceId}/ads/${adId}`);
    const { ad } = (await res.json()) as { ad: { status: string; durationMs: number; width: number; shots: { description: unknown }[]; elements: { kind: string }[] } };
    expect(ad.status).toBe("READY");
    expect(ad.width).toBe(640);
    expect(ad.durationMs).toBeGreaterThan(5_500);
    expect(ad.shots).toHaveLength(3);
    expect(ad.shots.every((s) => s.description)).toBe(true);
    expect(ad.elements.some((e) => e.kind === "ONSCREEN_TEXT")).toBe(true);
    // This workspace has no map, so there's nothing to compare with yet.
    expect((ad as unknown as { check: unknown }).check).toBeNull();

    const calls = await prisma.aiCall.findMany({ where: { adId } });
    expect(calls.map((c) => c.stage).sort()).toEqual(["audio", "context", "shot", "shot", "shot", "text"]);
    expect(calls.every((c) => c.provider === "practice" && c.costMicros === 0 && c.workspaceId === workspaceId && c.userId)).toBe(true);
    expect(calls.filter((c) => c.stage === "shot").every((c) => c.model.endsWith(config.gemini.models.smart))).toBe(true);
    expect(calls.filter((c) => c.stage !== "shot").every((c) => c.model.endsWith(config.gemini.models.fast))).toBe(true);
  });

  it("does nothing on a second delivery", async () => {
    const envelope = { id: randomUUID(), type: AD_CHECK, payload: { adId }, createdAt: new Date().toISOString(), attempt: 1 };
    expect(await adCheckHandlers[AD_CHECK]!.handle({ adId }, envelope)).toBe(Outcome.Skipped);
  });

  it("plays the video with byte ranges", async () => {
    const res = await call("viewer", "GET", `/api/v1/orgs/${workspaceId}/ads/${adId}/video`, undefined, { range: "bytes=0-99" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it("deletes the video but keeps the reading", async () => {
    expect((await call("viewer", "DELETE", `/api/v1/orgs/${workspaceId}/ads/${adId}/video`)).status).toBe(403);
    expect((await call("owner", "DELETE", `/api/v1/orgs/${workspaceId}/ads/${adId}/video`)).status).toBe(204);
    expect((await call("owner", "GET", `/api/v1/orgs/${workspaceId}/ads/${adId}/video`)).status).toBe(410);
    const { ad } = (await (await call("owner", "GET", `/api/v1/orgs/${workspaceId}/ads/${adId}`)).json()) as { ad: { hasVideo: boolean; shots: unknown[] } };
    expect(ad).toMatchObject({ hasVideo: false });
    expect(ad.shots).toHaveLength(3);
  });

  it("deletes a cancelled upload's file too (its suffixed name was never saved)", async () => {
    const clip = makeClip();
    const created = (await (await call("owner", "POST", `/api/v1/orgs/${workspaceId}/ads`, { fileName: "cancelled.mp4", sizeBytes: clip.length, contentType: "video/mp4" })).json()) as { adId: string; pathname: string; clientToken: string; access: "private" | "public" };
    const uploaded = await put(created.pathname, clip, { access: created.access, token: created.clientToken, contentType: "video/mp4" });
    expect((await call("owner", "DELETE", `/api/v1/orgs/${workspaceId}/ads/${created.adId}`)).status).toBe(204);
    expect(await describeBlob(uploaded.pathname)).toBeNull();
  });

  it("deletes the whole check", async () => {
    expect((await call("owner", "DELETE", `/api/v1/orgs/${workspaceId}/ads/${adId}`)).status).toBe(204);
    expect((await call("owner", "GET", `/api/v1/orgs/${workspaceId}/ads/${adId}`)).status).toBe(404);
  });
});
