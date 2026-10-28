import type { OrgKind } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";

/**
 * Qloo queries used this month against an account's allowance. The pool is the payer's: a brand
 * pays for itself unless its subscription names a payer (an agency paying for a client). Plan
 * allowances live on the subscription; without one, the plan defaults below apply.
 */

export const DEFAULT_ALLOWANCE: Record<OrgKind, number> = { WORKSPACE: 1_000, AGENCY: 10_000 };

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const nextMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export async function usageOf(organizationId: string, now = new Date()) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { id: true, name: true, kind: true, subscription: { select: { payerId: true, monthlyQueryAllowance: true } } },
  });
  const payerId = org.subscription?.payerId ?? org.id;
  const payer =
    payerId === org.id
      ? org
      : await prisma.organization.findUniqueOrThrow({ where: { id: payerId }, select: { id: true, name: true, kind: true, subscription: { select: { payerId: true, monthlyQueryAllowance: true } } } });
  const allowance = payer.subscription?.monthlyQueryAllowance ?? DEFAULT_ALLOWANCE[payer.kind];
  const since = monthStart(now);

  const [pool, mine, byKind, byWorkspace] = await Promise.all([
    prisma.usageLedger.aggregate({ where: { payerId, createdAt: { gte: since } }, _sum: { calls: true, cacheHits: true } }),
    prisma.usageLedger.aggregate({ where: { workspaceId: org.id, createdAt: { gte: since } }, _sum: { calls: true } }),
    prisma.usageLedger.groupBy({ by: ["kind"], where: { payerId, createdAt: { gte: since } }, _sum: { calls: true } }),
    prisma.usageLedger.groupBy({ by: ["workspaceId"], where: { payerId, createdAt: { gte: since } }, _sum: { calls: true } }),
  ]);
  const names = new Map(
    (await prisma.organization.findMany({ where: { id: { in: byWorkspace.map((w) => w.workspaceId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]),
  );

  return {
    used: pool._sum.calls ?? 0,
    allowance,
    cacheHits: pool._sum.cacheHits ?? 0,
    since: since.toISOString(),
    resetsOn: nextMonth(now).toISOString(),
    payer: { id: payer.id, name: payer.name, self: payer.id === org.id },
    /** This account's own share when it draws on someone else's pool. */
    ownUsed: mine._sum.calls ?? 0,
    byKind: byKind.map((k) => ({ kind: k.kind, calls: k._sum.calls ?? 0 })).filter((k) => k.calls > 0),
    byWorkspace: byWorkspace
      .map((w) => ({ workspaceId: w.workspaceId, name: names.get(w.workspaceId) ?? "A workspace", calls: w._sum.calls ?? 0 }))
      .filter((w) => w.calls > 0)
      .sort((a, b) => b.calls - a.calls),
  };
}

/** Plain names for what a Gemini call was for. Voice is its own stage; the rest follow the feature. */
const FEATURE_WORDS: Record<string, string> = { AD_CHECK: "Ad checks", PLAYS: "Writing plays", BRIEF: "Briefs", MAP_BUILD: "Culture Maps", LOOKUP: "Brand and place search" };
const AI_ACTIVITY = (stage: string, feature: string) => (stage === "voice" ? "Talking to X-Ray" : (FEATURE_WORDS[feature] ?? "Other"));

/**
 * This month's Gemini cost (ad checks, plays, talking to X-Ray), by person and by activity, from `ai_call` (each call's tokens priced when
 * it was made, usage/pricing.ts). A brand counts calls made in its workspace, whoever made them (its
 * agency's people included); an agency counts calls its own people made, in any client.
 */
export async function aiSpendOf(org: { id: string; kind: OrgKind }, now = new Date()) {
  const since = monthStart(now);
  const people = org.kind === "AGENCY" ? (await prisma.member.findMany({ where: { organizationId: org.id }, select: { userId: true } })).map((m) => m.userId) : null;
  const where = { provider: "vertex", createdAt: { gte: since }, ...(people ? { userId: { in: people } } : { workspaceId: org.id }) };
  const [byUser, byStage] = await Promise.all([
    prisma.aiCall.groupBy({ by: ["userId"], where, _sum: { costMicros: true }, _count: { _all: true } }),
    prisma.aiCall.groupBy({ by: ["stage", "feature"], where, _sum: { costMicros: true, durationMs: true } }),
  ]);
  const users = new Map(
    (await prisma.user.findMany({ where: { id: { in: byUser.map((u) => u.userId).filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]),
  );
  const activity = new Map<string, { costMicros: number; seconds: number }>();
  for (const s of byStage) {
    const name = AI_ACTIVITY(s.stage, s.feature);
    const a = activity.get(name) ?? { costMicros: 0, seconds: 0 };
    a.costMicros += s._sum.costMicros ?? 0;
    if (s.stage === "voice") a.seconds += Math.round((s._sum.durationMs ?? 0) / 1000);
    activity.set(name, a);
  }
  return {
    since: since.toISOString(),
    totalMicros: byUser.reduce((n, u) => n + (u._sum.costMicros ?? 0), 0),
    byPerson: byUser
      .map((u) => {
        const who = u.userId ? users.get(u.userId) : undefined;
        return { userId: u.userId, name: who?.name ?? "Someone no longer here", email: who?.email ?? null, calls: u._count._all, costMicros: u._sum.costMicros ?? 0 };
      })
      .sort((a, b) => b.costMicros - a.costMicros),
    byActivity: [...activity].map(([name, a]) => ({ name, costMicros: a.costMicros, ...(a.seconds ? { seconds: a.seconds } : {}) })).sort((a, b) => b.costMicros - a.costMicros),
  };
}
