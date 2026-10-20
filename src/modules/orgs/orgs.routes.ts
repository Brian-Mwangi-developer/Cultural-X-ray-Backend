import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/infra/database";
import { HttpError } from "@/http/errors";
import { requireAuth, sessionOf } from "@/modules/auth/require-auth";
import { isRole } from "@/modules/auth/roles";
import { domainOf, membershipOf, PUBLIC_EMAIL_DOMAINS, requireManager } from "@/modules/orgs/access";
import { audit } from "@/modules/orgs/audit";
import { slugProblem } from "@/modules/orgs/slugs";

export const orgsRouter = Router();

const MARKETS = ["US", "GB"] as const;

/** Is this URL free? Answers with a reason the person can act on. */
orgsRouter.get("/slugs/:slug", requireAuth, async (req, res, next) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return void res.json({ slug, available: false, reason: problem });
    const taken = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    res.json({ slug, available: !taken, reason: taken ? "That address is taken. Try another." : null });
  } catch (error) {
    next(error);
  }
});

/** Everything the app shell needs about one organisation, for one of its members. */
orgsRouter.get("/orgs/:slug", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { slug: String(req.params.slug) });
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organization.id },
      select: {
        id: true, kind: true, name: true, slug: true, logo: true, hqCountry: true, teamSize: true, billingEmail: true,
        markets: true, joinDomain: true, joinRole: true, connectCode: true, createdAt: true,
        custodian: { select: { id: true, name: true, slug: true } },
        _count: { select: { members: true } },
      },
    });
    const [invitations, clients, agencies, pendingRequests] = await Promise.all([
      prisma.invitation.count({ where: { organizationId: org.id, status: "pending", expiresAt: { gt: new Date() } } }),
      org.kind === "AGENCY" ? prisma.connection.count({ where: { agencyId: org.id, status: { in: ["ACTIVE", "REQUESTED"] } } }) : 0,
      org.kind === "WORKSPACE" ? prisma.connection.count({ where: { workspaceId: org.id, status: "ACTIVE" } }) : 0,
      org.kind === "WORKSPACE" ? prisma.connection.count({ where: { workspaceId: org.id, status: "REQUESTED" } }) : 0,
    ]);
    const { _count, connectCode, ...rest } = org;
    const isManager = member.role === "owner" || member.role === "admin";
    res.json({
      organization: { ...rest, connectCode: isManager ? connectCode : null },
      membership: { id: member.id, role: member.role, allClients: member.allClients },
      counts: { members: _count.members, invitations, clients, agencies, pendingRequests },
    });
  } catch (error) {
    next(error);
  }
});

const profileSchema = z
  .object({
    hqCountry: z.string().trim().max(64, "Use 64 characters or fewer.").nullable(),
    teamSize: z.enum(["1-10", "11-50", "51-200", "201+"], { message: "Choose a team size." }).nullable(),
    billingEmail: z.email("Enter a billing email like finance@agency.com.").nullable(),
    markets: z.array(z.enum(MARKETS)).min(1, "Choose at least one market.").max(MARKETS.length),
    joinDomain: z.string().trim().toLowerCase().nullable(),
    joinRole: z.enum(["viewer", "strategist"], { message: "People joining by domain can be Viewers or Strategists." }),
  })
  .partial();

/** Settings Better Auth doesn't own: markets, join-by-domain, and agency details. */
orgsRouter.patch("/orgs/:id/profile", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const { organization, member } = await membershipOf(user.id, { id: String(req.params.id) });
    requireManager(member.role, "change these settings");
    const input = profileSchema.parse(req.body);

    if (input.joinDomain) {
      // Only a domain you've proved you control by signing in with it, and never a public mailbox.
      if (input.joinDomain !== domainOf(user.email)) {
        throw new HttpError(400, `You can only open joining to @${domainOf(user.email)}, the domain you signed in with.`, { code: "JOIN_DOMAIN_MISMATCH" });
      }
      if (PUBLIC_EMAIL_DOMAINS.has(input.joinDomain)) {
        throw new HttpError(400, `Anyone can get an @${input.joinDomain} address, so it can't be used to join. Invite people by email instead.`, { code: "JOIN_DOMAIN_PUBLIC" });
      }
    }

    const updated = await prisma.organization.update({
      where: { id: organization.id },
      data: input,
      select: { id: true, hqCountry: true, teamSize: true, billingEmail: true, markets: true, joinDomain: true, joinRole: true },
    });
    await audit({ organizationId: organization.id, actorId: user.id, action: "organization.profile.updated", targetType: "organization", targetId: organization.id, data: { fields: Object.keys(input) } });
    res.json({ organization: updated });
  } catch (error) {
    next(error);
  }
});

/** Agencies and workspaces the signed-in person can join because of their verified email domain. */
orgsRouter.get("/me/joinable", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const domain = domainOf(user.email);
    if (!user.emailVerified || !domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return void res.json({ organizations: [] });
    const organizations = await prisma.organization.findMany({
      where: { joinDomain: domain, members: { none: { userId: user.id } } },
      select: { id: true, name: true, slug: true, kind: true, logo: true, joinRole: true, _count: { select: { members: true } } },
      take: 5,
    });
    res.json({ organizations: organizations.map(({ _count, ...o }) => ({ ...o, members: _count.members })) });
  } catch (error) {
    next(error);
  }
});

orgsRouter.post("/orgs/:id/join", requireAuth, async (req, res, next) => {
  try {
    const { user } = sessionOf(req);
    const org = await prisma.organization.findUnique({ where: { id: String(req.params.id) }, select: { id: true, slug: true, joinDomain: true, joinRole: true } });
    const domain = domainOf(user.email);
    if (!org || !user.emailVerified || !org.joinDomain || org.joinDomain !== domain || PUBLIC_EMAIL_DOMAINS.has(domain)) {
      throw new HttpError(404, "There's nothing to join here with your email address.", { code: "JOIN_NOT_ALLOWED" });
    }
    const role = org.joinRole && isRole(org.joinRole) && (org.joinRole === "viewer" || org.joinRole === "strategist") ? org.joinRole : "viewer";
    await prisma.member.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      create: { id: crypto.randomUUID(), organizationId: org.id, userId: user.id, role },
      update: {},
    });
    await audit({ organizationId: org.id, actorId: user.id, action: "member.joined_by_domain", targetType: "user", targetId: user.id, data: { role } });
    res.status(201).json({ slug: org.slug, role });
  } catch (error) {
    next(error);
  }
});

/** Public summary of an invitation so the invite page can greet someone before they sign in. */
orgsRouter.get("/invitations/:id/preview", async (req, res, next) => {
  try {
    const invitation = await prisma.invitation.findUnique({
      where: { id: String(req.params.id) },
      select: {
        id: true, email: true, role: true, status: true, expiresAt: true,
        organization: { select: { name: true, kind: true, logo: true, slug: true } },
        user: { select: { name: true } },
      },
    });
    if (!invitation) throw new HttpError(404, "This invitation doesn't exist. Ask for a new one.", { code: "INVITATION_NOT_FOUND" });
    const account = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
    res.json({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expired: invitation.expiresAt < new Date(),
      expiresAt: invitation.expiresAt,
      organization: invitation.organization,
      inviter: { name: invitation.user.name },
      accountExists: Boolean(account),
    });
  } catch (error) {
    next(error);
  }
});
