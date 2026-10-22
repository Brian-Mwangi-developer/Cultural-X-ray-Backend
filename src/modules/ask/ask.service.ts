import type { UIMessage } from "ai";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { HttpError } from "@/http/errors";

/** What we keep about a reply: which model wrote it and what it cost, so credit use is visible. */
export type AskMetadata = { model?: string; practice?: boolean; inputTokens?: number; outputTokens?: number; createdAt?: string };
export type AskMessage = UIMessage<AskMetadata>;

const titleOf = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 70 ? `${t.slice(0, 67)}…` : t;
};

export const textOf = (m: AskMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();

/** A person's own thread in this workspace, or a new one titled by the first question. */
export async function threadFor(workspaceId: string, userId: string, threadId: string | undefined, first: AskMessage) {
  if (threadId) {
    const thread = await prisma.askThread.findFirst({ where: { id: threadId, workspaceId, userId }, select: { id: true } });
    if (!thread) throw new HttpError(404, "We couldn't find that conversation.", { code: "ASK_THREAD_NOT_FOUND" });
    return thread.id;
  }
  // One round trip. The thread's map link is left empty; answers always read the latest map.
  const thread = await prisma.askThread.create({ data: { workspaceId, userId, title: titleOf(textOf(first)) || "New chat" }, select: { id: true } });
  return thread.id;
}

export async function messagesOf(threadId: string): Promise<AskMessage[]> {
  const rows = await prisma.askMessage.findMany({ where: { threadId }, orderBy: { createdAt: "asc" }, select: { id: true, role: true, parts: true, metadata: true } });
  return rows.map((r) => ({ id: r.id, role: r.role === "USER" ? "user" : "assistant", parts: r.parts as AskMessage["parts"], metadata: (r.metadata ?? undefined) as AskMetadata | undefined }));
}

/** Saving is idempotent by message id, so a retried request never duplicates a turn. */
export async function saveMessage(threadId: string, message: AskMessage) {
  const data = { threadId, role: message.role === "user" ? ("USER" as const) : ("ASSISTANT" as const), parts: message.parts as Prisma.InputJsonValue, metadata: (message.metadata ?? undefined) as Prisma.InputJsonValue | undefined };
  await prisma.$transaction([
    prisma.askMessage.upsert({ where: { id: message.id }, create: { id: message.id, ...data }, update: { parts: data.parts, metadata: data.metadata } }),
    prisma.askThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } }),
  ]);
}

export async function threadsOf(workspaceId: string, userId: string) {
  return prisma.askThread.findMany({ where: { workspaceId, userId }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, title: true, updatedAt: true } });
}

export async function threadWithMessages(workspaceId: string, userId: string, threadId: string) {
  const thread = await prisma.askThread.findFirst({ where: { id: threadId, workspaceId, userId }, select: { id: true, title: true, updatedAt: true } });
  if (!thread) throw new HttpError(404, "We couldn't find that conversation.", { code: "ASK_THREAD_NOT_FOUND" });
  return { thread, messages: await messagesOf(thread.id) };
}

export async function deleteThread(workspaceId: string, userId: string, threadId: string) {
  const { count } = await prisma.askThread.deleteMany({ where: { id: threadId, workspaceId, userId } });
  if (!count) throw new HttpError(404, "We couldn't find that conversation.", { code: "ASK_THREAD_NOT_FOUND" });
}
