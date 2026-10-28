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
