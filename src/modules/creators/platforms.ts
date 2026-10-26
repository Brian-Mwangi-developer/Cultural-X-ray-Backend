import { errorDetails, logger } from "@/observability/logger";

/**
 * A person's public channels, found without keys or sign-in: the handles Qloo lists for them are
 * tried on YouTube (the public @handle page, then the channel's public feed) and TikTok (its official
 * oEmbed). A channel only counts when it is confirmed as theirs: its name is the person's name, or it
 * presents itself under the very handle Qloo lists. Anything else is a stranger with the same handle
 * (seen in the probe: @themontydon is someone else). Content is shown through each platform's own
 * embed in the viewer's browser; nothing here downloads media.
 */

export type Match = "name" | "handle";
export type YouTubeChannel = { channelId: string; handle: string; title: string; description: string; subscribers: string | null; match: Match };
export type Video = { id: string; title: string; published: string; views: number | null };
export type TikTokProfile = { handle: string; name: string; match: Match };

const TIMEOUT_MS = 8_000;
const HEADERS = { "accept-language": "en-GB,en;q=0.8", "user-agent": "Mozilla/5.0 (compatible; CulturalXRay/1.0; +https://culturalxray.app)" };

export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Whether an account's display name confirms it belongs to `person`, given the handle it was found under. */
export function matchOf(person: string, display: string, handle: string): Match | null {
  const p = norm(person);
  const d = norm(display);
  if (!d) return null;
  if (d === p) return "name";
  // An account named after its own handle, written as one word, only tells us the handle: "TheMontyDon"
  // could be anyone. "Chef Tom Kerridge" is a real display name that happens to match its handle.
  if (d === norm(handle) && !/\s/.test(display.trim())) return "handle";
  if (p.length >= 6 && d.includes(p)) return "name";
  // "Chef Tom Kerridge", "Tom Kerridge Official": every part of the person's name is in it.
  const parts = person.toLowerCase().normalize("NFKD").split(/[\s.\-’']+/).map(norm).filter((x) => x.length >= 2);
  if (parts.length >= 2 && parts.every((x) => d.includes(x))) return "name";
  if (d === norm(handle)) return "handle";
  return null;
}

/** Handles worth trying for a person: the ones Qloo lists, then their name run together. */
export function candidates(person: string, handles: string[]) {
  const listed = handles.map((h) => h.replace(/^@/, "").toLowerCase()).filter(Boolean);
  return [...new Set([...listed, norm(person)])].filter((h) => /^[a-z0-9._-]{2,40}$/.test(h)).slice(0, 4);
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** The facts we use from a channel's public page. */
export function channelFromPage(html: string, handle: string) {
  const channelId = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1];
  if (!channelId) return null;
  const title = decode(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "");
  const description = decode(html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? "");
  // The page states its own count next to its handle: "@ChefTomKerridge • 30.6k subscribers".
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subscribers = html.match(new RegExp(`@${esc}[\\u2069\\s]*•[\\u2068\\s]*([\\d.,]+[kKMB]?) subscribers`, "i"))?.[1] ?? null;
  return { channelId, title, description, subscribers };
}

/** A channel's latest uploads from its public feed (newest first). */
export function videosFromFeed(xml: string): Video[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: e!.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1] ?? "",
    title: decode(e!.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    published: e!.match(/<published>([^<]*)<\/published>/)?.[1] ?? "",
    views: Number(e!.match(/<media:statistics views="(\d+)"/)?.[1] ?? NaN) || null,
  })).filter((v) => v.id);
}

async function get(url: string) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.text() : null;
  } catch (error) {
    logger.debug({ url, ...errorDetails(error) }, "creators: fetch failed");
    return null;
  }
}

export async function findYouTube(person: string, handles: string[]): Promise<YouTubeChannel | null> {
  for (const handle of candidates(person, handles)) {
    const html = await get(`https://www.youtube.com/@${handle}`);
    const page = html ? channelFromPage(html, handle) : null;
    if (!page) continue;
    // YouTube shows a stranger's videos on the card itself (seen: a fan video under @sjdooley), so only a
    // channel named for the person, or describing them by name, counts here.
    const long = norm(person).length >= 6;
    let named = matchOf(person, page.title, handle) === "name" || (long && norm(page.description).includes(norm(person)));
    // A channel named after its handle ("GiuseppeCooks") counts when its own recent videos name the person.
    if (!named && long && matchOf(person, page.title, handle) === "handle") {
      const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${page.channelId}`);
      named = Boolean(xml && videosFromFeed(xml).some((v) => norm(v.title).includes(norm(person))));
    }
    if (named) return { ...page, handle, match: "name" };
  }
  return null;
}

/** Latest uploads, or null when the feed can't be read (it has brief outages; callers cache). */
export async function latestVideos(channelId: string, take = 6): Promise<Video[] | null> {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  return xml ? videosFromFeed(xml).slice(0, take) : null;
}

export async function findTikTok(person: string, handles: string[]): Promise<TikTokProfile | null> {
  for (const handle of candidates(person, handles)) {
    const body = await get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(`https://www.tiktok.com/@${handle}`)}`);
    if (!body) continue;
    let name = "";
    try {
      name = String((JSON.parse(body) as { author_name?: string }).author_name ?? "");
    } catch {
      continue;
    }
    const match = matchOf(person, name, handle);
    if (match) return { handle, name, match };
  }
  return null;
}
