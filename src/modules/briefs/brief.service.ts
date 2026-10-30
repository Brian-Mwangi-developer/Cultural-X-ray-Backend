import { randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { audienceForModel } from "@/modules/ask/ask.tools";
import { type BriefInput, briefPrompt, briefSchema, practiceBrief, type Section, SECTIONS, toLines } from "@/modules/briefs/brief.write";
import { generate } from "@/modules/gemini/gemini.client";
import { memoriesOf, memoryOn } from "@/modules/guide/guide.memory";
import { contextFor } from "@/modules/plays/plays.queue";

const summary = { id: true, title: true, occasion: true, placements: true, status: true, shareToken: true, createdAt: true, updatedAt: true, author: { select: { name: true } } } as const;

/** Who the customers are and where they go, in the words the brief needs (from Audience & places). */
async function audienceWords(workspaceId: string) {
  const a = await audienceForModel(workspaceId).catch(() => null);
  if (!a || a.status !== "ready") return null;
  const strong = Array.isArray(a.groups) ? a.groups.filter((g) => /strong/.test(String((g as Record<string, unknown>).you ?? ""))).map((g) => String(g.group)) : [];
  const places = (a.places ?? []).slice(0, 5).map((p) => p.place);
  return [strong.length ? `Strongest with ${strong.join(", ")}.` : "", places.length ? `They go to ${places.join(", ")}.` : ""].filter(Boolean).join(" ") || null;
}

/**
 * Write a brief from the workspace's latest map (one text call to Gemini, then code keeps only what the
 * map backs). Waits for the answer: a brief takes about 10–20 seconds.
 */
export async function writeBrief(workspaceId: string, userId: string, authorOrgId: string, input: { occasion: string; placements: string[] }) {
  const map = await prisma.cultureMap.findFirst({ where: { workspaceId, status: "READY" }, orderBy: { createdAt: "desc" }, select: { id: true, market: true } });
  if (!map) throw new HttpError(409, "Build your Culture Map first: the brief is written from it.", { code: "BRIEF_NO_MAP" });
  const context = await contextFor(map.id);
  if (!context || !context.items.length) throw new HttpError(409, "Your Culture Map has nothing to write a brief from yet.", { code: "BRIEF_EMPTY_MAP" });

  const [notes, remembering, audience, ad] = await Promise.all([
    memoriesOf(userId, workspaceId, 8),
    memoryOn(userId),
    audienceWords(workspaceId),
    prisma.adCheck.findFirst({ where: { ad: { workspaceId, status: "READY" } }, orderBy: { createdAt: "desc" }, select: { verdict: true, ad: { select: { title: true } } } }),
  ]);
  const brief: BriefInput = {
    occasion: input.occasion,
    placements: input.placements,
    notes: remembering ? notes.map((n) => n.fact) : [],
    audience,
    adRead: ad ? `“${ad.ad.title}”: ${(ad.verdict as { headline?: string }).headline ?? ""}` : null,
  };
  const { json } = await generate({ stage: "brief", tier: "smart", parts: [briefPrompt(context, brief)], schema: briefSchema, practice: practiceBrief(context, brief), attribution: { feature: "BRIEF", userId, workspaceId } });
  const { title, lines } = toLines(json, context, input.placements);

  return prisma.brief.create({
    data: {
      workspaceId,
      mapId: map.id,
      title,
      occasion: input.occasion,
      placements: input.placements,
      market: map.market,
      authorId: userId,
      authorOrgId,
      items: { create: lines.map((l, i) => ({ section: l.section, text: l.text, position: i, refs: l.refs as unknown as Prisma.InputJsonArray, state: l.refs.length ? "CITED" : "INSIGHT_ONLY" })) },
    },
    select: { id: true },
  });
}

export async function listBriefs(workspaceId: string) {
  return prisma.brief.findMany({ where: { workspaceId, status: { not: "ARCHIVED" } }, orderBy: { updatedAt: "desc" }, select: { ...summary, _count: { select: { items: true } } } });
}

const full = {
  ...summary,
  market: true,
  workspace: { select: { name: true, logo: true } },
  authorOrg: { select: { name: true, kind: true } },
  items: { orderBy: { position: "asc" }, select: { id: true, section: true, text: true, refs: true, state: true } },
} as const;

export async function briefOf(workspaceId: string, briefId: string) {
  const brief = await prisma.brief.findFirst({ where: { id: briefId, workspaceId }, select: full });
  if (!brief) throw new HttpError(404, "We couldn't find that brief.");
  return brief;
}

/** Save the whole brief as edited: title, and every line in order. Lines keep their refs when kept; new lines cite nothing. */
export async function saveBrief(workspaceId: string, briefId: string, edit: { title?: string; occasion?: string; items?: { id?: string; section: Section; text: string }[] }) {
  const brief = await briefOf(workspaceId, briefId);
  const known = new Map(brief.items.map((i) => [i.id, i]));
  await prisma.$transaction([
    prisma.brief.update({ where: { id: briefId }, data: { ...(edit.title ? { title: edit.title } : {}), ...(edit.occasion !== undefined ? { occasion: edit.occasion } : {}) } }),
    ...(edit.items
      ? [
          prisma.briefItem.deleteMany({ where: { briefId } }),
          prisma.briefItem.createMany({
            data: edit.items
              .filter((i) => SECTIONS.includes(i.section) && i.text.trim())
              .map((i, position) => {
                const was = i.id ? known.get(i.id) : undefined;
                // Rewording a line keeps what it rests on; a new line rests on nothing until it's checked.
                return { briefId, section: i.section, text: i.text.trim(), position, refs: (was?.refs ?? undefined) as Prisma.InputJsonValue | undefined, state: was?.state ?? "UNCITED" };
              }),
          }),
        ]
      : []),
  ]);
  return briefOf(workspaceId, briefId);
}

export async function deleteBrief(workspaceId: string, briefId: string) {
  await briefOf(workspaceId, briefId);
  await prisma.brief.delete({ where: { id: briefId } });
}

/** Turn the read-only link on (a fresh, unguessable token) or off (the old link stops working). */
export async function shareBrief(workspaceId: string, briefId: string, on: boolean) {
  await briefOf(workspaceId, briefId);
  const token = on ? randomBytes(18).toString("base64url") : null;
  await prisma.brief.update({ where: { id: briefId }, data: { shareToken: token, status: on ? "SHARED" : "DRAFT" } });
  return token;
}

/** A brief by its share link, for anyone with the link. */
export async function sharedBrief(token: string) {
  const brief = await prisma.brief.findUnique({ where: { shareToken: token }, select: full });
  if (!brief) throw new HttpError(404, "This link was turned off or never existed.");
  return brief;
}
