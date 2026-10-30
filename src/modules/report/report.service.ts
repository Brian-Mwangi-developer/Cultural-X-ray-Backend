import { randomBytes } from "node:crypto";
import { HttpError } from "@/http/errors";
import { prisma } from "@/infra/database";
import { listAds } from "@/modules/adcheck/adcheck.service";
import { basisOf } from "@/modules/maps/map.basis";
import { audienceOf, latestMap } from "@/modules/maps/map.service";
import { listPlays } from "@/modules/plays/plays.service";

/**
 * The culture report: everything the overview knows about a brand, in one read, for the printable
 * report and its share link. The latest ready map with its top items, who the customers are and where
 * they go, the plays, and the last few ad checks. Live: a shared link always shows the latest.
 */
export async function reportOf(workspaceId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, name: true, logo: true, markets: true, kind: true, reportShareToken: true } });
  if (org.kind !== "WORKSPACE") throw new HttpError(404, "Reports are for a brand’s workspace.");
  const [map, audience, plays, ads, basis] = await Promise.all([latestMap(workspaceId, 8), audienceOf(workspaceId), listPlays(workspaceId), listAds(workspaceId), basisOf(workspaceId)]);
  return {
    brand: { id: org.id, name: org.name, logo: org.logo, market: org.markets[0] ?? "GB" },
    shareToken: org.reportShareToken,
    map: map?.status === "READY" ? map : null,
    audience,
    plays: plays.plays,
    ads: ads.filter((a) => a.status === "READY").slice(0, 3),
    basis,
    generatedAt: new Date().toISOString(),
  };
}

export async function shareReport(workspaceId: string, on: boolean) {
  const token = on ? randomBytes(18).toString("base64url") : null;
  await prisma.organization.update({ where: { id: workspaceId }, data: { reportShareToken: token } });
  return token;
}

export async function sharedReport(token: string) {
  const org = await prisma.organization.findUnique({ where: { reportShareToken: token }, select: { id: true } });
  if (!org) throw new HttpError(404, "This link was turned off or never existed.");
  const { shareToken: _hidden, ...report } = await reportOf(org.id);
  return report;
}
