import { prisma } from "@/infra/database";

/**
 * What Ask X-Ray remembers about a person in a workspace (plan-guide.md §5): short facts in plain
 * words, written by the assistant's `remember` tool when the person tells it something lasting.
 * On by default; the person sees every note in Settings › Profile, deletes any, or turns it off.
 */

export const MEMORY_CAP = 30;
export const FACT_MAX = 200;
/** How many of the newest notes go into each prompt. */
export const IN_PROMPT = 10;

/** Off is a mark on the person (workspace ""), so it holds across workspaces. */
const OFF = { workspaceId: "", key: "memory:off" };

export async function memoryOn(userId: string) {
  return !(await prisma.guideMark.findUnique({ where: { userId_workspaceId_key: { userId, ...OFF } }, select: { id: true } }));
}

export async function setMemoryOn(userId: string, on: boolean) {
  if (on) await prisma.guideMark.deleteMany({ where: { userId, ...OFF } });
  else await prisma.guideMark.upsert({ where: { userId_workspaceId_key: { userId, ...OFF } }, create: { userId, ...OFF }, update: {} });
}

export async function memoriesOf(userId: string, workspaceId: string, take = MEMORY_CAP) {
  return prisma.guideMemory.findMany({ where: { userId, workspaceId }, orderBy: { createdAt: "desc" }, take, select: { id: true, fact: true, source: true, createdAt: true } });
}

/** Plain words, one line, trimmed; the same note twice is kept once. */
export const tidy = (fact: string) => fact.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "").slice(0, FACT_MAX);
/** The same note said slightly differently ("Opening a new shop in Leeds in May" / "Opening a shop in Leeds in May"). */
const FILLER = new Set(["a", "an", "the", "new", "our", "my", "we", "are", "is", "in", "on", "at", "to", "of", "for", "by"]);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !FILLER.has(w)));
export function same(a: string, b: string) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(x.size, y.size) >= 0.8;
}

export async function remember(userId: string, workspaceId: string, fact: string, source: "said" | "picked" = "said") {
  if (!(await memoryOn(userId))) return { kept: false as const, reason: "The person has turned memory off." };
  const text = tidy(fact);
  if (text.length < 4) return { kept: false as const, reason: "Too short to be useful." };
  const existing = await memoriesOf(userId, workspaceId);
  if (existing.some((m) => same(m.fact, text))) return { kept: true as const, note: "Already remembered." };
  const row = await prisma.guideMemory.create({ data: { userId, workspaceId, fact: text, source }, select: { id: true } });
  // Over the cap, the oldest go: what someone said months ago matters less than this week.
  if (existing.length + 1 > MEMORY_CAP) {
    const drop = existing.slice(MEMORY_CAP - 1).map((m) => m.id);
    await prisma.guideMemory.deleteMany({ where: { id: { in: drop } } });
  }
  return { kept: true as const, id: row.id, fact: text };
}

export async function forget(userId: string, workspaceId: string, id: string | "all") {
  await prisma.guideMemory.deleteMany({ where: { userId, workspaceId, ...(id === "all" ? {} : { id }) } });
}
