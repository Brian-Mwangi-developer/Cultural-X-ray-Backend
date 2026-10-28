import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { UsageKind } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { errorDetails, logger } from "@/observability/logger";

/**
 * Counting Qloo queries per account. Work that calls Qloo runs inside `withMeter` (a map build,
 * a filtered map view, an ad check, a lookup), and the Qloo client reports each call here. Only
 * calls that reach Qloo count; answers served from our cache are noted as cache hits and are free.
 *
 * Each row names the workspace the work was for and the payer: whoever its subscription says pays
 * (an agency paying for a client), else the workspace itself. Changing plans or who pays later is a
 * subscription change; the ledger doesn't move.
 */

export type Meter = { workspaceId: string; kind: UsageKind; userId?: string | null; mapId?: string | null };

const context = new AsyncLocalStorage<Meter>();

export function withMeter<T>(meter: Meter | null, work: () => Promise<T>): Promise<T> {
  return meter ? context.run(meter, work) : work();
}

export const currentMeter = () => context.getStore() ?? null;

/**
 * Express middleware for lookups (brand search and the like): they count against the account the
 * person is working in. Before they have one (the first steps of onboarding) nothing is counted.
 */
export function meterLookups(req: Request, _res: Response, next: NextFunction) {
  const session = req.session;
  const workspaceId = (session?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId;
  if (!session || !workspaceId) return next();
  context.run({ workspaceId, kind: "LOOKUP", userId: session.user.id }, next);
}

const PAYER_TTL_MS = 60_000;
const payers = new Map<string, { payerId: string; at: number }>();

async function payerOf(workspaceId: string) {
  const hit = payers.get(workspaceId);
  if (hit && Date.now() - hit.at < PAYER_TTL_MS) return hit.payerId;
  const sub = await prisma.subscription.findUnique({ where: { organizationId: workspaceId }, select: { payerId: true } });
  const payerId = sub?.payerId ?? workspaceId;
  payers.set(workspaceId, { payerId, at: Date.now() });
  return payerId;
}

/** Note one Qloo call. Never throws: losing a usage row must not fail the work that made the call. */
export async function recordQlooCall(path: string, cacheHit: boolean): Promise<void> {
  const meter = currentMeter();
  if (!meter) {
    if (!cacheHit) logger.debug({ path }, "usage: a Qloo call outside any account");
    return;
  }
  try {
    await prisma.usageLedger.create({
      data: {
        payerId: await payerOf(meter.workspaceId),
        workspaceId: meter.workspaceId,
        mapId: meter.mapId ?? null,
        kind: meter.kind,
        calls: cacheHit ? 0 : 1,
        cacheHits: cacheHit ? 1 : 0,
        userId: meter.userId ?? null,
        path,
      },
    });
  } catch (error) {
    logger.warn({ path, workspaceId: meter.workspaceId, ...errorDetails(error) }, "usage: could not record a Qloo call");
  }
}
