import { randomBytes } from "node:crypto";
import { BlobNotFoundError, del, head } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";

/**
 * Brand images: a business's logo and a person's photo. The browser uploads straight to Vercel Blob
 * with a short-lived token for one path; the server then checks what arrived (an image, small enough)
 * before saving its link. Blobs are public, so logos show on share links and PDFs too. No SVG: it can
 * carry script.
 */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 2_000_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export type ImageKind = "logo" | "photo";
const folder = (kind: ImageKind, ownerId: string) => `${kind === "logo" ? "logos" : "photos"}/${ownerId}/`;

function needStorage() {
  if (!config.blob.token) throw new HttpError(503, "Image uploads aren’t set up yet.", { code: "MEDIA_OFF" });
}

/** Where the browser may write, and a token for exactly that path. */
export async function imageTarget(kind: ImageKind, ownerId: string, file: { contentType: string; sizeBytes: number }) {
  needStorage();
  if (!(IMAGE_TYPES as readonly string[]).includes(file.contentType)) throw new HttpError(400, "Upload a PNG, JPEG or WebP image.", { code: "MEDIA_TYPE" });
  if (file.sizeBytes > MAX_IMAGE_BYTES) throw new HttpError(400, "Images can be up to 2 MB.", { code: "MEDIA_SIZE" });
  const pathname = `${folder(kind, ownerId)}${randomBytes(8).toString("hex")}.${EXT[file.contentType]}`;
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: config.blob.token,
    pathname,
    maximumSizeInBytes: MAX_IMAGE_BYTES,
    allowedContentTypes: [...IMAGE_TYPES],
    validUntil: Date.now() + 10 * 60_000,
    addRandomSuffix: false,
  });
  return { pathname, clientToken, access: config.blob.access };
}

/** After the upload: the file must be ours, an image and small enough. Returns its public link. */
async function checked(kind: ImageKind, ownerId: string, pathname: string) {
  if (!pathname.startsWith(folder(kind, ownerId)) || pathname.includes("..")) throw new HttpError(400, "That upload doesn’t belong here.", { code: "MEDIA_PATH" });
  try {
    const blob = await head(pathname, { token: config.blob.token });
    if (!(IMAGE_TYPES as readonly string[]).includes(blob.contentType) || blob.size > MAX_IMAGE_BYTES) throw new HttpError(400, "That file isn’t a usable image.", { code: "MEDIA_TYPE" });
    return blob.url;
  } catch (error) {
    if (error instanceof BlobNotFoundError) throw new HttpError(409, "The upload didn’t finish. Try again.", { code: "MEDIA_NOT_UPLOADED" });
    throw error;
  }
}

/** The previous image, when it's one of ours, is removed once replaced. Others (Google photos) are left alone. */
async function dropOld(url: string | null | undefined) {
  if (!url || !url.includes(".blob.vercel-storage.com/")) return;
  await del(url, { token: config.blob.token }).catch(() => undefined);
}

export async function setLogo(orgId: string, pathname: string | null) {
  needStorage();
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { logo: true } });
  const url = pathname ? await checked("logo", orgId, pathname) : null;
  await prisma.organization.update({ where: { id: orgId }, data: { logo: url } });
  if (org.logo !== url) await dropOld(org.logo);
  return url;
}

export async function setPhoto(userId: string, pathname: string | null) {
  needStorage();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { image: true } });
  const url = pathname ? await checked("photo", userId, pathname) : null;
  await prisma.user.update({ where: { id: userId }, data: { image: url } });
  if (user.image !== url) await dropOld(user.image);
  return url;
}
