import { prisma } from "@/infra/database";
import { HttpError } from "@/http/errors";
import { MANAGER_ROLES, type RoleName } from "@/modules/auth/roles";

/**
 * The caller's membership in an organisation, or a 404. Non-members get "not found"
 * rather than "forbidden" so an org's existence never leaks through its id or slug.
 */
export async function membershipOf(userId: string, where: { id: string } | { slug: string }) {
  // One round trip: the membership with its organisation (the database is far from the API).
  const found = await prisma.member.findFirst({
    where: { userId, organization: where },
    select: { id: true, role: true, allClients: true, organization: { select: { id: true, kind: true, name: true, slug: true } } },
  });
  if (!found) throw new HttpError(404, "We couldn't find that workspace.", { code: "ORG_NOT_FOUND" });
  const { organization, ...member } = found;
  return { organization, member };
}

/** What each access level a brand grants lets an agency's people do, as a workspace role. */
const GRANTED: Record<"VIEW" | "EDIT" | "MANAGE", RoleName> = { VIEW: "viewer", EDIT: "strategist", MANAGE: "admin" };
const RANK: Record<string, number> = { viewer: 0, strategist: 1, admin: 2, owner: 3 };
const lower = (a: string, b: RoleName) => ((RANK[a] ?? 0) <= RANK[b]! ? a : b);

/**
 * Who may see a workspace's data (maps, audience, ad checks, Ask X-Ray), and as what.
 *
 * - A member of the workspace: their own role.
 * - Someone at an agency: only through an ACTIVE connection between their agency and the workspace,
 *   and only if they may see that client (all clients, or given this one). Their role is the lower of
 *   their agency role and what the brand granted (VIEW → viewer, EDIT → strategist, MANAGE → admin),
 *   so an agency viewer never gains more, and nobody at an agency becomes an owner.
 * - Anyone else: the same 404 as membershipOf, so a workspace's existence never leaks.
 *
 * Settings, members and connections stay with membershipOf: agencies never manage a brand's account.
 */
export async function workspaceAccess(userId: string, where: { id: string } | { slug: string }) {
  const own = await prisma.member.findFirst({
    where: { userId, organization: where },
    select: { id: true, role: true, allClients: true, organization: { select: { id: true, kind: true, name: true, slug: true } } },
  });
  if (own) {
    const { organization, ...member } = own;
    return { organization, member, via: "member" as const, agencyId: null };
  }
  const connection = await prisma.connection.findFirst({
    where: { status: "ACTIVE", access: { not: null }, workspace: { ...where, kind: "WORKSPACE" }, agency: { members: { some: { userId } } } },
    select: {
      access: true,
      agencyId: true,
      workspace: { select: { id: true, kind: true, name: true, slug: true } },
      agency: { select: { members: { where: { userId }, select: { id: true, role: true, allClients: true }, take: 1 } } },
      memberAccess: { where: { member: { userId } }, select: { memberId: true }, take: 1 },
    },
  });
  const agencyMember = connection?.agency.members[0];
  if (!connection?.access || !agencyMember || (!agencyMember.allClients && connection.memberAccess.length === 0)) {
    throw new HttpError(404, "We couldn't find that workspace.", { code: "ORG_NOT_FOUND" });
  }
  return {
    organization: connection.workspace,
    member: { id: agencyMember.id, role: lower(agencyMember.role, GRANTED[connection.access]), allClients: false },
    via: "agency" as const,
    agencyId: connection.agencyId,
  };
}

export function requireRole(role: string, allowed: readonly RoleName[], action = "do that") {
  if (!(allowed as readonly string[]).includes(role)) {
    const who = allowed.map((r) => `${r}s`);
    const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who[0];
    throw new HttpError(403, `Only ${list} can ${action}.`, { code: "FORBIDDEN_ROLE" });
  }
}

export const requireManager = (role: string, action?: string) => requireRole(role, MANAGER_ROLES, action);

/** Mailbox providers anyone can sign up to; "anyone at this domain can join" makes no sense for them. */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "yandex.com", "hey.com", "fastmail.com",
]);

export const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
