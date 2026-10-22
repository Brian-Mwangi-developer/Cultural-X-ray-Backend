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

export function requireRole(role: string, allowed: readonly RoleName[], action = "do that") {
  if (!(allowed as readonly string[]).includes(role)) {
    throw new HttpError(403, `Only ${allowed.map((r) => (r === "owner" ? "owners" : `${r}s`)).join(" and ")} can ${action}.`, { code: "FORBIDDEN_ROLE" });
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
