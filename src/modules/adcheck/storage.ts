import { BlobNotFoundError, del, get, head } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { config } from "@/config/env";

/**
 * Ad videos live in Vercel Blob, private by default. The browser uploads straight to Blob with a
 * short-lived client token that only allows one path, one size limit and video types; only the
 * backend can read the file back (the worker for Gemini, the video endpoint for playback).
 *
 * Private access is a setting of the Blob store itself. On a public store (BLOB_ACCESS=public) each
 * upload gets a random suffix so its URL can't be guessed, and the browser reports the final path.
 */

export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
const TOKEN_MINUTES = 60;

export const storageReady = () => Boolean(config.blob.token);
const token = () => config.blob.token;

/** `ads/<workspace>/<ad>/<file>`, with the file name reduced to safe characters. */
export function videoPath(workspaceId: string, adId: string, fileName: string) {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) : "";
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).normalize("NFKD").replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "ad";
  return `ads/${workspaceId}/${adId}/${stem}${ext ? `.${ext}` : ""}`;
}

/** The final path the browser reports after uploading must stay inside the path it was given. */
export function uploadedPath(given: string, reported: string | undefined) {
  if (!reported || reported === given) return given;
  const dir = given.slice(0, given.lastIndexOf("/") + 1);
  const name = given.slice(dir.length).replace(/\.[^.]+$/, "");
  return reported.startsWith(dir + name) && !reported.slice(dir.length).includes("/") && !reported.includes("..") ? reported : null;
}

export async function uploadToken(pathname: string, maxBytes: number) {
  return generateClientTokenFromReadWriteToken({
    token: token(),
    pathname,
    maximumSizeInBytes: maxBytes,
    allowedContentTypes: [...VIDEO_TYPES],
    validUntil: Date.now() + TOKEN_MINUTES * 60_000,
    addRandomSuffix: config.blob.access === "public",
    allowOverwrite: true,
  });
}

/** Size and type of an uploaded video, or null when nothing is there. */
export async function describe(pathname: string) {
  try {
    const blob = await head(pathname, { token: token() });
    return { size: blob.size, contentType: blob.contentType, url: blob.url };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

/** The whole video, for the worker. */
export async function download(pathname: string): Promise<Buffer | null> {
  const found = await get(pathname, { access: config.blob.access, token: token(), useCache: false });
  if (!found || found.statusCode !== 200) return null;
  return Buffer.from(await new Response(found.stream).arrayBuffer());
}

/** A stream for playback, honouring a byte range when the player asks for one. */
export async function stream(pathname: string, range?: string) {
  const found = await get(pathname, { access: config.blob.access, token: token(), ...(range ? { headers: { range } } : {}) });
  if (!found || found.statusCode !== 200) return null;
  const h = found.headers;
  return {
    status: h.get("content-range") ? 206 : 200,
    body: found.stream,
    headers: {
      "content-type": found.blob.contentType,
      ...(h.get("content-length") ? { "content-length": h.get("content-length")! } : {}),
      ...(h.get("content-range") ? { "content-range": h.get("content-range")! } : {}),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=300",
    },
  };
}

/** Delete the video. Deleting what is already gone is fine. */
export async function remove(pathname: string) {
  await del(pathname, { token: token() });
}
