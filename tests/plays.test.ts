import { describe, expect, it } from "vitest";
import { candidates, channelFromPage, matchOf, videosFromFeed } from "@/modules/creators/platforms";
import { keepBacked, type PlayContext, type PlayItem, playsPrompt, playsSchema, practicePlays, proofOf } from "@/modules/plays/plays";

const item = (ref: string, name: string, kind: PlayItem["kind"], label: PlayItem["label"], p: Partial<PlayItem> = {}): PlayItem => ({ ref, entityId: `e-${ref}`, name, kind, label, rival: null, lean: null, rank: 0, detail: null, ...p });
// Jude's map, as it reads: bakers and gardeners are yours, a comedian is shared, Japanese stars are Häagen-Dazs'.
const CTX: PlayContext = {
  brand: "Jude's", market: "GB", rivals: ["Ben & Jerry's", "Häagen-Dazs"], readings: [],
  items: [
    item("i1", "Nadiya Hussain", "PERSON", "YOURS"),
    item("i2", "Tom Kerridge", "PERSON", "YOURS", { rank: 1 }),
    item("i3", "Joe Lycett", "PERSON", "CONTESTED", { rival: "Ben & Jerry's", lean: 0.7, rank: 2 }),
    item("i4", "Hikaru Utada", "PERSON", "THEIRS", { rival: "Häagen-Dazs" }),
    item("i5", "The Rest Is History", "PODCAST", "YOURS"),
    item("i6", "Cornwall", "DESTINATION", "YOURS"),
    item("i7", "Atomic Habits", "BOOK", "YOURS"),
  ],
};
const play = (items: string[], title = "Do it") => ({ items, title, body: "b", why: "w", brief: [] });

describe("plays: only what the map backs", () => {
  it("drops plays on rivals' ground, unknown items and books, and takes the kind from the map", () => {
    const rows = keepBacked({ plays: [play(["i4"]), play(["i99"]), play(["i7"]), play(["i5"], "Sponsor it")] }, CTX);
    expect(rows.map((r) => [r.title, r.kind])).toEqual([["Sponsor it", "PODCAST"]]);
  });

  it("keeps a play's items to its first item's category and to your side", () => {
    const [row] = keepBacked({ plays: [play(["i1", "i4", "i5", "i3"])] }, CTX);
    expect(row!.items.map((i) => i.name)).toEqual(["Nadiya Hussain", "Joe Lycett"]);
    expect(row!.entityId).toBe("e-i1");
  });

  it("never makes two plays on the same item, and at most two per kind", () => {
    const rows = keepBacked({ plays: [play(["i1"]), play(["i1"]), play(["i2"]), play(["i3"]), play(["i6"])] }, CTX);
    expect(rows.map((r) => r.entityId)).toEqual(["e-i1", "e-i2", "e-i6"]);
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 2]);
  });

  it("practice answers pass the schema and survive the checks", () => {
    const answer = playsSchema.parse(practicePlays(CTX));
    expect(keepBacked(answer, CTX).map((r) => r.kind)).toEqual(["CREATOR", "PODCAST", "PLACE"]);
  });

  it("shows Gemini rivals' ground without a ref, and asks for no scores or looks", () => {
    const p = playsPrompt(CTX);
    expect(p).toContain("- · Hikaru Utada · only Häagen-Dazs's customers");
    expect(p).toContain("i3 · Joe Lycett · shared with Ben & Jerry's, leans your way");
    expect(p).toMatch(/no numbers, no scores/);
    expect(p).toMatch(/Never claim anything about ad spend/);
    expect(p).toMatch(/never comment on anyone's age, body, face or looks/);
  });

  it("explains each source in words, with no scores", () => {
    expect(proofOf(CTX.items[1]!, CTX.rivals)).toBe("Tom Kerridge is 2nd among the creators your customers follow on Qloo, and Ben & Jerry's or Häagen-Dazs’ customers don’t rank it.");
    expect(proofOf(CTX.items[2]!, CTX.rivals)).toBe("Joe Lycett is 3rd among the creators your customers follow on Qloo. Ben & Jerry's customers rank it too, and it sits higher on your customers’ list.");
  });
});

describe("creators: a channel counts only when it's theirs", () => {
  it("confirms by name, or by the very handle Qloo lists; rejects strangers", () => {
    expect(matchOf("Tom Kerridge", "Chef Tom Kerridge", "cheftomkerridge")).toBe("name");
    expect(matchOf("Joe Wicks", "The Body Coach", "thebodycoach")).toBe("handle");
    expect(matchOf("Monty Don", "Shane Pyle", "themontydon")).toBeNull(); // seen in the probe
    expect(matchOf("Giuseppe Dell’Anno", "user3683486377136", "giuseppecooks")).toBeNull();
    expect(matchOf("Lizzo", "Lizzo Official Vibes", "lizzobeeating")).toBeNull(); // a fan page
    expect(matchOf("Monty Don", "TheMontyDon", "themontydon")).toBe("handle"); // named after its handle: could be anyone
    expect(matchOf("Joe Lycett", "joelycett", "joelycett")).toBe("name");
  });

  it("tries the listed handles, then the name run together", () => {
    expect(candidates("Nadiya Hussain", ["NadiyaJHussain", "@BegumNadiya"])).toEqual(["nadiyajhussain", "begumnadiya", "nadiyahussain"]);
  });

  it("reads a channel page and its public feed", () => {
    const html = `<link rel="canonical" href="https://www.youtube.com/channel/UC9lZ3cHlNPBbXbF-3OUlsjQ"><meta property="og:title" content="Chef Tom Kerridge"><meta property="og:description" content="Cook along &amp; enjoy">{"content":"‎⁨@ChefTomKerridge⁩ • ⁨30.6k subscribers⁩"}`;
    expect(channelFromPage(html, "cheftomkerridge")).toEqual({ channelId: "UC9lZ3cHlNPBbXbF-3OUlsjQ", title: "Chef Tom Kerridge", description: "Cook along & enjoy", subscribers: "30.6k" });
    const xml = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>Sunday roast &amp; gravy</title><published>2026-10-20T10:00:00+00:00</published><media:statistics views="41230"/></entry></feed>`;
    expect(videosFromFeed(xml)).toEqual([{ id: "abcdefghijk", title: "Sunday roast & gravy", published: "2026-10-20T10:00:00+00:00", views: 41230 }]);
  });
});
