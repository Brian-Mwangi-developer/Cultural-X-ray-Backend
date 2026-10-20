import { createHash, randomBytes, randomInt } from "node:crypto";
import type { AccessLevel, Prisma } from "@/generated/prisma/client";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { HttpError } from "@/http/errors";
import { enqueueEmail } from "@/modules/email/email.queue";
import { membershipOf, requireManager } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import { newConnectCode } from "@/modules/orgs/connect-code";
import { slugify, slugProblem } from "@/modules/orgs/slugs";
import { logger, errorDetails } from "@/observability/logger";

const CLAIM_DAYS = 14;
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Same shape as Better Auth's ids, so rows created here look like rows it created. */
export const newId = () => Array.from({ length: 32 }, () => ALNUM[randomInt(ALNUM.length)]).join("");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type Actor = { id: string; name: string; email: string; emailVerified: boolean };

/** Emails are best-effort: the change already happened, so a queue hiccup is logged, not thrown. */
async function notify(job: Parameters<typeof enqueueEmail>[0]) {
  try {
    await enqueueEmail(job);
  } catch (error) {
    logger.error({ ...errorDetails(error), template: job.template }, "notification email not queued");
  }
}

async function managersOf(organizationId: string) {
  return prisma.member.findMany({
    where: { organizationId, role: { in: ["owner", "admin"] } },
    select: { user: { select: { email: true, name: true } } },
  });
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name).replace(/-/g, "") || "workspace";
  const stem = slugProblem(base) ? `${base}-brand`.slice(0, 40) : base.slice(0, 40);
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    if (slugProblem(candidate)) continue;
    const taken = await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${stem}-${randomBytes(3).toString("hex")}`;
}

async function requireAgency(actor: Actor, agencyId: string, action: string) {
  const { organization, member } = await membershipOf(actor.id, { id: agencyId });
  if (organization.kind !== "AGENCY") throw new HttpError(400, "Only agencies can add clients.", { code: "NOT_AN_AGENCY" });
  requireManager(member.role, action);
  return { agency: organization, member };
}

/* --------------------------------------------------------------- create */

export async function createClientWorkspace(
  actor: Actor,
  agencyId: string,
  input: { brandName: string; rivals: string[]; market: "US" | "GB"; ownerEmail: string; access: AccessLevel },
) {
  const { agency } = await requireAgency(actor, agencyId, "add clients");
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (ownerEmail === actor.email.toLowerCase()) {
    throw new HttpError(400, "Use the client owner's email, not yours. They become the owner when they claim it.", { code: "CLAIM_SELF" });
  }

  const slug = await uniqueSlug(input.brandName);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CLAIM_DAYS * 24 * 60 * 60 * 1000);
  const connectCode = await newConnectCode(input.brandName);

  const result = await prisma.$transaction(async (tx) => {
    const workspace = await tx.organization.create({
      data: {
        id: newId(),
        kind: "WORKSPACE",
        name: input.brandName.trim(),
        slug,
        markets: [input.market],
        custodianId: agency.id,
        connectCode,
        metadata: JSON.stringify({ rivals: input.rivals, setUpBy: agency.id }),
      },
      select: { id: true, name: true, slug: true },
    });
    const connection = await tx.connection.create({
      data: {
        agencyId: agency.id,
        workspaceId: workspace.id,
        status: "ACTIVE",
        origin: "AGENCY_CREATED",
        accessRequested: input.access,
        access: input.access,
        requestedById: actor.id,
        decidedAt: new Date(),
      },
      select: { id: true },
    });
    const claim = await tx.workspaceClaim.create({
      data: { workspaceId: workspace.id, agencyId: agency.id, email: ownerEmail, tokenHash: hashToken(token), requestedAccess: input.access, expiresAt, createdById: actor.id },
      select: { id: true, expiresAt: true },
    });
    await audit({ organizationId: agency.id, actorId: actor.id, action: "client.created", targetType: "organization", targetId: workspace.id, data: { access: input.access } }, tx);
    await audit({ organizationId: workspace.id, actorId: actor.id, action: "workspace.created_in_trust", targetType: "connection", targetId: connection.id, data: { agencyId: agency.id } }, tx);
    return { workspace, connection, claim };
  });

  await notify({
    template: "workspace-claim",
    to: ownerEmail,
    agencyName: agency.name,
    inviterName: actor.name,
    workspaceName: result.workspace.name,
    access: input.access,
    url: `${config.http.publicWebUrl}/claim/${token}`,
    expiresAt: expiresAt.toISOString(),
  });

  return result;
}

/* -------------------------------------------------------------- connect */

export async function requestConnection(actor: Actor, agencyId: string, input: { code: string; access: AccessLevel }) {
  const { agency } = await requireAgency(actor, agencyId, "connect clients");
  const code = input.code.trim().toUpperCase();
  const workspace = await prisma.organization.findUnique({ where: { connectCode: code }, select: { id: true, name: true, slug: true, kind: true } });
  if (!workspace || workspace.kind !== "WORKSPACE") {
    throw new HttpError(404, "No workspace has that code. Check it with your client; it looks like NORTHLINE-7KQ2.", { code: "CODE_NOT_FOUND" });
  }

  const existing = await prisma.connection.findUnique({ where: { agencyId_workspaceId: { agencyId: agency.id, workspaceId: workspace.id } } });
  if (existing?.status === "ACTIVE") throw new HttpError(409, `You're already connected to ${workspace.name}.`, { code: "ALREADY_CONNECTED" });
  if (existing?.status === "REQUESTED") throw new HttpError(409, `You've already asked ${workspace.name}. They'll see it in Settings.`, { code: "ALREADY_REQUESTED" });

  const data = {
    status: "REQUESTED" as const,
    origin: "WORKSPACE_CODE" as const,
    accessRequested: input.access,
    access: null,
    requestedById: actor.id,
    requestedAt: new Date(),
    decidedById: null,
    decidedAt: null,
    endedAt: null,
    endedBy: null,
    endReason: null,
  };
  const connection = existing
    ? await prisma.connection.update({ where: { id: existing.id }, data, select: { id: true, status: true } })
    : await prisma.connection.create({ data: { agencyId: agency.id, workspaceId: workspace.id, ...data }, select: { id: true, status: true } });

  await audit({ organizationId: workspace.id, actorId: actor.id, action: "connection.requested", targetType: "connection", targetId: connection.id, data: { agencyId: agency.id, access: input.access } });
  for (const manager of await managersOf(workspace.id)) {
    await notify({
      template: "connection-request",
      to: manager.user.email,
      agencyName: agency.name,
      requesterName: actor.name,
      workspaceName: workspace.name,
      access: input.access,
      url: `${config.http.publicWebUrl}/${workspace.slug}/settings/agencies`,
    });
  }
  return { connection, workspace: { name: workspace.name } };
}

/* ----------------------------------------------------------------- lists */

export async function listClients(actor: Actor, agencyId: string) {
  const { organization, member } = await membershipOf(actor.id, { id: agencyId });
  if (organization.kind !== "AGENCY") throw new HttpError(400, "Only agencies have clients.", { code: "NOT_AN_AGENCY" });

  const visible: Prisma.ConnectionWhereInput = member.allClients ? {} : { memberAccess: { some: { memberId: member.id } } };
  const connections = await prisma.connection.findMany({
    where: { agencyId, status: { in: ["ACTIVE", "REQUESTED", "DECLINED"] }, ...visible },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true, status: true, origin: true, access: true, accessRequested: true, requestedAt: true,
      workspace: {
        select: {
          id: true, name: true, slug: true, custodianId: true, markets: true,
          members: { where: { role: "owner" }, select: { user: { select: { name: true, email: true } } }, take: 1 },
          claims: { where: { agencyId }, orderBy: { createdAt: "desc" }, take: 1, select: { email: true, status: true, expiresAt: true } },
        },
      },
      _count: { select: { memberAccess: true } },
    },
  });
  const allClientsCount = await prisma.member.count({ where: { organizationId: agencyId, allClients: true } });

  return connections.map((c) => {
    const claim = c.workspace.claims[0];
    const owner = c.workspace.members[0]?.user;
    const heldInTrust = c.workspace.custodianId === agencyId;
    return {
      id: c.id,
      status: c.status,
      origin: c.origin,
      access: c.access,
      accessRequested: c.accessRequested,
      requestedAt: c.requestedAt,
      workspace: { id: c.workspace.id, name: c.workspace.name, slug: c.workspace.slug, markets: c.workspace.markets },
      owner: owner ? { name: owner.name, email: owner.email } : null,
      claim: claim && !owner ? { email: claim.email, status: claim.status, expired: claim.expiresAt < new Date(), expiresAt: claim.expiresAt } : null,
      heldInTrust,
      billedTo: heldInTrust ? organization.name : c.status === "ACTIVE" ? c.workspace.name : null,
      team: c.status === "ACTIVE" ? allClientsCount + c._count.memberAccess : 0,
    };
  });
}

export async function listAgencies(actor: Actor, workspaceId: string) {
  const { organization } = await membershipOf(actor.id, { id: workspaceId });
  if (organization.kind !== "WORKSPACE") throw new HttpError(400, "Only brand workspaces connect to agencies.", { code: "NOT_A_WORKSPACE" });
  const connections = await prisma.connection.findMany({
    where: { workspaceId, status: { in: ["ACTIVE", "REQUESTED"] } },
    orderBy: [{ status: "desc" }, { requestedAt: "desc" }],
    select: {
      id: true, status: true, origin: true, access: true, accessRequested: true, requestedAt: true, decidedAt: true,
      agency: { select: { id: true, name: true, logo: true, members: { where: { allClients: true }, select: { user: { select: { name: true } } }, take: 6 } } },
      requestedBy: { select: { name: true, email: true } },
      memberAccess: { select: { member: { select: { user: { select: { name: true } } } } }, take: 6 },
    },
  });
  return connections.map((c) => ({
    id: c.id,
    status: c.status,
    origin: c.origin,
    access: c.access,
    accessRequested: c.accessRequested,
    requestedAt: c.requestedAt,
    decidedAt: c.decidedAt,
    agency: { id: c.agency.id, name: c.agency.name, logo: c.agency.logo },
    requestedBy: c.requestedBy,
    people: [...new Set([...c.agency.members.map((m) => m.user.name), ...c.memberAccess.map((m) => m.member.user.name)])],
  }));
}

/* ------------------------------------------------------------- decisions */

async function connectionForWorkspaceManager(actor: Actor, connectionId: string) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, status: true, workspaceId: true, agencyId: true, accessRequested: true, workspace: { select: { name: true, slug: true } }, agency: { select: { name: true, slug: true } } },
  });
  if (!connection) throw new HttpError(404, "That connection no longer exists.", { code: "CONNECTION_NOT_FOUND" });
  const { member } = await membershipOf(actor.id, { id: connection.workspaceId });
  requireManager(member.role, "decide what agencies can do");
  return connection;
}

export async function decideConnection(actor: Actor, connectionId: string, input: { approve: boolean; access?: AccessLevel }) {
  const connection = await connectionForWorkspaceManager(actor, connectionId);
  if (connection.status !== "REQUESTED") throw new HttpError(409, "This request has already been answered.", { code: "ALREADY_DECIDED" });
  const updated = await prisma.connection.update({
    where: { id: connection.id },
    data: input.approve
      ? { status: "ACTIVE", access: input.access ?? connection.accessRequested, decidedById: actor.id, decidedAt: new Date() }
      : { status: "DECLINED", decidedById: actor.id, decidedAt: new Date() },
    select: { id: true, status: true, access: true },
  });
  await audit({ organizationId: connection.workspaceId, actorId: actor.id, action: input.approve ? "connection.approved" : "connection.declined", targetType: "connection", targetId: connection.id, data: { access: updated.access } });
  return updated;
}

export async function changeAccess(actor: Actor, connectionId: string, access: AccessLevel) {
  const connection = await connectionForWorkspaceManager(actor, connectionId);
  if (connection.status !== "ACTIVE") throw new HttpError(409, "Only connected agencies have access to change.", { code: "NOT_ACTIVE" });
  const updated = await prisma.connection.update({ where: { id: connection.id }, data: { access }, select: { id: true, access: true } });
  await audit({ organizationId: connection.workspaceId, actorId: actor.id, action: "connection.access_changed", targetType: "connection", targetId: connection.id, data: { access } });
  return updated;
}

/** Either side can end it. The workspace and everything in it always stays with the brand. */
export async function endConnection(actor: Actor, connectionId: string, input: { keepPdf?: boolean; reason?: string }) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, status: true, agencyId: true, workspaceId: true, workspace: { select: { name: true, slug: true, custodianId: true } }, agency: { select: { name: true, slug: true } } },
  });
  if (!connection || connection.status === "ENDED") throw new HttpError(404, "That connection has already ended.", { code: "CONNECTION_NOT_FOUND" });

  const [agencySide, workspaceSide] = await Promise.all([
    prisma.member.findUnique({ where: { organizationId_userId: { organizationId: connection.agencyId, userId: actor.id } }, select: { role: true } }),
    prisma.member.findUnique({ where: { organizationId_userId: { organizationId: connection.workspaceId, userId: actor.id } }, select: { role: true } }),
  ]);
  const side = workspaceSide && ["owner", "admin"].includes(workspaceSide.role) ? "WORKSPACE" : agencySide && ["owner", "admin"].includes(agencySide.role) ? "AGENCY" : null;
  if (!side) {
    if (!agencySide && !workspaceSide) throw new HttpError(404, "That connection has already ended.", { code: "CONNECTION_NOT_FOUND" });
    throw new HttpError(403, "Only owners and admins can end a connection.", { code: "FORBIDDEN_ROLE" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.connection.update({
      where: { id: connection.id },
      data: { status: "ENDED", endedAt: new Date(), endedBy: side, endReason: input.reason?.slice(0, 500) ?? null, agencyKeepsPdf: side === "AGENCY" ? Boolean(input.keepPdf) : false },
    });
    await tx.memberClientAccess.deleteMany({ where: { connectionId: connection.id } });
    // An unclaimed workspace stays claimable by its owner; the agency just stops holding it.
    if (connection.workspace.custodianId === connection.agencyId) {
      await tx.organization.update({ where: { id: connection.workspaceId }, data: { custodianId: null } });
    }
    await audit({ organizationId: connection.workspaceId, actorId: actor.id, action: "connection.ended", targetType: "connection", targetId: connection.id, data: { by: side } }, tx);
    await audit({ organizationId: connection.agencyId, actorId: actor.id, action: "connection.ended", targetType: "connection", targetId: connection.id, data: { by: side } }, tx);
  });

  const otherSide = side === "AGENCY" ? connection.workspaceId : connection.agencyId;
  const recipients = (await managersOf(otherSide)).map((m) => m.user.email);
  if (side === "AGENCY" && !recipients.length) {
    const claim = await prisma.workspaceClaim.findFirst({ where: { workspaceId: connection.workspaceId, status: "PENDING" }, select: { email: true } });
    if (claim) recipients.push(claim.email);
  }
  for (const to of recipients) {
    await notify({
      template: "connection-ended",
      to,
      agencyName: connection.agency.name,
      workspaceName: connection.workspace.name,
      endedBy: side,
      url: `${config.http.publicWebUrl}/dashboard`,
    });
  }
  return { id: connection.id, endedBy: side };
}

/* ---------------------------------------------------------------- claims */

async function claimByToken(token: string) {
  const claim = await prisma.workspaceClaim.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true, email: true, status: true, expiresAt: true, requestedAccess: true, workspaceId: true, agencyId: true,
      workspace: { select: { name: true, slug: true, markets: true, metadata: true, _count: { select: { maps: true, briefs: true } } } },
      agency: { select: { name: true, logo: true } },
      createdBy: { select: { name: true } },
    },
  });
  if (!claim) throw new HttpError(404, "This claim link doesn't exist. Ask the agency to send a new one.", { code: "CLAIM_NOT_FOUND" });
  return claim;
}

export async function previewClaim(token: string) {
  const claim = await claimByToken(token);
  const account = await prisma.user.findUnique({ where: { email: claim.email }, select: { id: true } });
  let rivals: string[] = [];
  try {
    rivals = (JSON.parse(claim.workspace.metadata ?? "{}") as { rivals?: string[] }).rivals ?? [];
  } catch {
    rivals = [];
  }
  return {
    email: claim.email,
    status: claim.status,
    expired: claim.expiresAt < new Date(),
    expiresAt: claim.expiresAt,
    requestedAccess: claim.requestedAccess,
    workspace: { name: claim.workspace.name, slug: claim.workspace.slug, markets: claim.workspace.markets, rivals, maps: claim.workspace._count.maps, briefs: claim.workspace._count.briefs },
    agency: { name: claim.agency.name, logo: claim.agency.logo },
    createdBy: claim.createdBy?.name ?? null,
    accountExists: Boolean(account),
  };
}

function assertClaimable(claim: Awaited<ReturnType<typeof claimByToken>>, actor: Actor) {
  if (claim.status !== "PENDING") throw new HttpError(410, claim.status === "CLAIMED" ? "This workspace has already been claimed." : "This claim link is no longer active.", { code: "CLAIM_CLOSED" });
  if (claim.expiresAt < new Date()) throw new HttpError(410, "This claim link has expired. Ask the agency to send a new one.", { code: "CLAIM_EXPIRED" });
  if (actor.email.toLowerCase() !== claim.email.toLowerCase()) {
    throw new HttpError(403, `This claim is for ${claim.email}. Log in with that address to claim it.`, { code: "CLAIM_WRONG_ACCOUNT" });
  }
  if (!actor.emailVerified) throw new HttpError(403, "Confirm your email before claiming.", { code: "EMAIL_NOT_VERIFIED" });
}

export async function acceptClaim(actor: Actor, token: string, access: AccessLevel) {
  const claim = await claimByToken(token);
  assertClaimable(claim, actor);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.workspaceClaim.updateMany({ where: { id: claim.id, status: "PENDING" }, data: { status: "CLAIMED", claimedById: actor.id, claimedAt: new Date() } });
    if (updated.count !== 1) throw new HttpError(409, "This workspace was just claimed.", { code: "CLAIM_CLOSED" });
    await tx.member.upsert({
      where: { organizationId_userId: { organizationId: claim.workspaceId, userId: actor.id } },
      create: { id: newId(), organizationId: claim.workspaceId, userId: actor.id, role: "owner" },
      update: { role: "owner" },
    });
    await tx.organization.update({ where: { id: claim.workspaceId }, data: { custodianId: null } });
    await tx.connection.updateMany({ where: { agencyId: claim.agencyId, workspaceId: claim.workspaceId, status: "ACTIVE" }, data: { access, decidedById: actor.id, decidedAt: new Date() } });
    await audit({ organizationId: claim.workspaceId, actorId: actor.id, action: "workspace.claimed", targetType: "claim", targetId: claim.id, data: { access } }, tx);
  });
  return { slug: claim.workspace.slug };
}

export async function declineClaim(actor: Actor, token: string) {
  const claim = await claimByToken(token);
  assertClaimable(claim, actor);
  await prisma.workspaceClaim.update({ where: { id: claim.id }, data: { status: "DECLINED" } });
  await audit({ organizationId: claim.workspaceId, actorId: actor.id, action: "workspace.claim_declined", targetType: "claim", targetId: claim.id });
  return { declined: true };
}

/* ---------------------------------------------------------- connect code */

export async function rotateConnectCode(actor: Actor, workspaceId: string) {
  const { organization, member } = await membershipOf(actor.id, { id: workspaceId });
  if (organization.kind !== "WORKSPACE") throw new HttpError(400, "Only brand workspaces have a connect code.", { code: "NOT_A_WORKSPACE" });
  requireManager(member.role, "change the workspace code");
  const connectCode = await newConnectCode(organization.name);
  await prisma.organization.update({ where: { id: workspaceId }, data: { connectCode } });
  await audit({ organizationId: workspaceId, actorId: actor.id, action: "workspace.connect_code_rotated", targetType: "organization", targetId: workspaceId });
  return { connectCode };
}
