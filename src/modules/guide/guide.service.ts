import { prisma } from "@/infra/database";
import { type Facts, type Goal, GOALS, nextStep, stepsFor } from "@/modules/guide/guide.steps";

/** Marks about the person rather than a workspace (welcome room, goal) live under workspace "". */
const PERSON = "";

/** Keys the web may set. Anything else is refused, so the table can't fill with junk. */
export const MARK_KEY = /^(seen|tour|bar|visit|done)(:[a-z0-9-]{1,40})?$/;

export async function marksOf(userId: string, workspaceId: string) {
  return prisma.guideMark.findMany({ where: { userId, workspaceId }, select: { key: true, at: true } });
}

export async function setMarks(userId: string, workspaceId: string, add: string[], remove: string[]) {
  const now = new Date();
  // Separate statements, not one transaction: nothing here needs to be all-or-nothing, and an
  // interactive transaction to a distant database can time out before it starts.
  if (remove.length) await prisma.guideMark.deleteMany({ where: { userId, workspaceId, OR: remove.map((k) => (k.endsWith(":*") ? { key: { startsWith: k.slice(0, -1) } } : { key: k })) } });
  // Setting a mark again moves its time on: "visit" is the last time the person came by.
  await Promise.all(add.map((key) => prisma.guideMark.upsert({ where: { userId_workspaceId_key: { userId, workspaceId, key } }, create: { userId, workspaceId, key, at: now }, update: { at: now } })));
}

/** The welcome room: done or not, and the goal picked there. */
export async function personOf(userId: string) {
  const marks = await marksOf(userId, PERSON);
  const goal = marks.find((m) => m.key.startsWith("goal:"))?.key.slice(5) as Goal | undefined;
  return { welcomed: marks.some((m) => m.key === "welcome"), goal: goal && GOALS.includes(goal) ? goal : null };
}

export async function welcome(userId: string, goal: Goal | null) {
  await prisma.guideMark.deleteMany({ where: { userId, workspaceId: PERSON, key: { startsWith: "goal:" } } });
  await Promise.all([
    prisma.guideMark.upsert({ where: { userId_workspaceId_key: { userId, workspaceId: PERSON, key: "welcome" } }, create: { userId, workspaceId: PERSON, key: "welcome" }, update: {} }),
    goal ? prisma.guideMark.create({ data: { userId, workspaceId: PERSON, key: `goal:${goal}` } }) : null,
  ]);
}

/** The agency a person belongs to, when they did something in this workspace without being its member. */
async function agencyNameFor(actorId: string | null | undefined, workspaceId: string, members: Set<string>) {
  if (!actorId || members.has(actorId)) return null;
  const c = await prisma.connection.findFirst({ where: { workspaceId, agency: { members: { some: { userId: actorId } } } }, select: { agency: { select: { name: true } } } });
  return c?.agency.name ?? null;
}

async function factsOf(org: { id: string; kind: "WORKSPACE" | "AGENCY" }, seen: Set<string>): Promise<Facts> {
  const [memberRows, invites] = await Promise.all([
    prisma.member.findMany({ where: { organizationId: org.id }, select: { userId: true, allClients: true } }),
    prisma.invitation.count({ where: { organizationId: org.id, status: "pending" } }),
  ]);
  const teammates = memberRows.length > 1 || invites > 0;
  if (org.kind === "AGENCY") {
    const clients = await prisma.connection.count({ where: { agencyId: org.id, status: "ACTIVE" } });
    return { kind: "AGENCY", clients: clients > 0, seenClientMap: seen.has("seen:client-map"), teammates, access: memberRows.some((m) => !m.allClients) };
  }
  const members = new Set(memberRows.map((m) => m.userId));
  const [map, ad, building] = await Promise.all([
    prisma.cultureMap.findFirst({ where: { workspaceId: org.id, status: "READY" }, orderBy: { createdAt: "asc" }, select: { createdById: true } }),
    prisma.ad.findFirst({ where: { workspaceId: org.id, status: "READY" }, orderBy: { createdAt: "asc" }, select: { uploadedById: true } }),
    prisma.cultureMap.count({ where: { workspaceId: org.id, status: { in: ["QUEUED", "BUILDING"] } } }),
  ]);
  return {
    kind: "WORKSPACE",
    mapReady: Boolean(map),
    mapBuilding: building > 0,
    mapBy: map ? await agencyNameFor(map.createdById, org.id, members) : null,
    seenMap: seen.has("seen:map"),
    seenPlays: seen.has("seen:plays"),
    adRead: Boolean(ad),
    adBy: ad ? await agencyNameFor(ad.uploadedById, org.id, members) : null,
    teammates,
  };
}

const NEWS_AFTER_MS = 6 * 3_600_000;

/** What changed since the person's last visit, if they've been away a while. Read once, then "visit" moves on. */
async function newsSince(workspaceId: string, since: Date | null) {
  if (!since || Date.now() - since.getTime() < NEWS_AFTER_MS) return null;
  const [maps, plays, ads] = await Promise.all([
    prisma.cultureMap.count({ where: { workspaceId, status: "READY", builtAt: { gt: since } } }),
    prisma.play.count({ where: { map: { workspaceId }, createdAt: { gt: since } } }),
    prisma.ad.findMany({ where: { workspaceId, status: "READY", readAt: { gt: since } }, select: { id: true, title: true }, orderBy: { readAt: "desc" }, take: 3 }),
  ]);
  const items = [
    ...(maps ? [{ id: "map", text: maps > 1 ? "Your Culture Map was rebuilt" : "Your Culture Map was built again", page: "map" }] : []),
    ...(plays ? [{ id: "plays", text: `${plays} new ${plays === 1 ? "play" : "plays"}`, page: "plays" }] : []),
    ...ads.map((a) => ({ id: `ad-${a.id}`, text: `“${a.title}” finished reading`, page: `ad-check/${a.id}` })),
  ];
  return items.length ? { since: since.toISOString(), items } : null;
}

export async function guideOf(userId: string, org: { id: string; kind: "WORKSPACE" | "AGENCY" }) {
  const [marks, person] = await Promise.all([marksOf(userId, org.id), personOf(userId)]);
  const seen = new Set(marks.map((m) => m.key));
  const facts = await factsOf(org, seen);
  const steps = stepsFor(facts);
  const visit = marks.find((m) => m.key === "visit")?.at ?? null;
  return {
    steps,
    next: nextStep(steps, person.goal),
    goal: person.goal,
    marks: [...seen],
    news: org.kind === "WORKSPACE" ? await newsSince(org.id, visit) : null,
  };
}
