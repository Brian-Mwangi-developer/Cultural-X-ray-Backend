import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessLevel, ConnectionStatus } from "@/generated/prisma/client";
import { prisma } from "@/infra/database";
import { requireRole, workspaceAccess } from "@/modules/orgs/access";

/**
 * Who can see a workspace's data. Agencies see a client only through an active connection, only
 * for the people allowed that client, and never with more than the brand granted.
 */

const run = randomUUID().slice(0, 8);
const id = (s: string) => `${s}-${run}`;
const users = { owner: id("owner"), allClients: id("all"), given: id("given"), notGiven: id("notgiven"), agencyViewer: id("aviewer"), stranger: id("stranger") };
const orgs = { workspace: id("ws"), agency: id("ag"), otherAgency: id("ag2") };
let connectionId = "";

async function setConnection(status: ConnectionStatus, access: AccessLevel | null) {
  await prisma.connection.update({ where: { id: connectionId }, data: { status, access } });
}

beforeAll(async () => {
  await prisma.user.createMany({ data: Object.values(users).map((u) => ({ id: u, name: u, email: `${u}@xray.test`, emailVerified: true })) });
  await prisma.organization.createMany({
    data: [
      { id: orgs.workspace, kind: "WORKSPACE", name: "Kettle Lane", slug: `kl${run}` },
      { id: orgs.agency, kind: "AGENCY", name: "Harbor & Pine", slug: `hp${run}` },
      { id: orgs.otherAgency, kind: "AGENCY", name: "Other Agency", slug: `oa${run}` },
    ],
  });
  await prisma.member.createMany({
    data: [
      { id: id("m-owner"), organizationId: orgs.workspace, userId: users.owner, role: "owner" },
      { id: id("m-all"), organizationId: orgs.agency, userId: users.allClients, role: "admin", allClients: true },
      { id: id("m-given"), organizationId: orgs.agency, userId: users.given, role: "strategist", allClients: false },
      { id: id("m-notgiven"), organizationId: orgs.agency, userId: users.notGiven, role: "strategist", allClients: false },
      { id: id("m-aviewer"), organizationId: orgs.agency, userId: users.agencyViewer, role: "viewer", allClients: true },
      { id: id("m-stranger"), organizationId: orgs.otherAgency, userId: users.stranger, role: "owner", allClients: true },
    ],
  });
  const connection = await prisma.connection.create({
    data: { agencyId: orgs.agency, workspaceId: orgs.workspace, status: "ACTIVE", origin: "WORKSPACE_CODE", accessRequested: "EDIT", access: "EDIT" },
  });
  connectionId = connection.id;
  await prisma.memberClientAccess.create({ data: { memberId: id("m-given"), connectionId } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: Object.values(orgs) } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.$disconnect();
});

const roleOf = async (userId: string) => (await workspaceAccess(userId, { id: orgs.workspace })).member.role;
const denied = (userId: string) => expect(workspaceAccess(userId, { id: orgs.workspace })).rejects.toMatchObject({ status: 404, code: "ORG_NOT_FOUND" });

describe("workspace access", () => {
  it("lets the brand's own people in with their own role", async () => {
    const access = await workspaceAccess(users.owner, { slug: `kl${run}` });
    expect(access).toMatchObject({ via: "member", member: { role: "owner" }, organization: { id: orgs.workspace } });
  });

  it("lets an agency's people in through an active connection, capped at what the brand granted", async () => {
    await setConnection("ACTIVE", "EDIT");
    expect(await roleOf(users.allClients)).toBe("strategist"); // an agency admin, but the brand granted EDIT
    expect(await roleOf(users.given)).toBe("strategist");
    expect(await roleOf(users.agencyViewer)).toBe("viewer"); // never more than their own role
    const access = await workspaceAccess(users.given, { id: orgs.workspace });
    expect(access).toMatchObject({ via: "agency", agencyId: orgs.agency });
  });

  it("follows the grant: VIEW reads only, MANAGE acts as admin but never as owner", async () => {
    await setConnection("ACTIVE", "VIEW");
    expect(await roleOf(users.allClients)).toBe("viewer");
    expect(() => requireRole("viewer", ["owner", "admin", "strategist"], "check ads")).toThrow();
    await setConnection("ACTIVE", "MANAGE");
    expect(await roleOf(users.allClients)).toBe("admin");
    await setConnection("ACTIVE", "EDIT");
  });

  it("keeps clients from agency people who weren't given them", async () => {
    await denied(users.notGiven);
  });

  it("closes the door when the connection isn't active", async () => {
    for (const status of ["REQUESTED", "DECLINED", "ENDED"] as const) {
      await setConnection(status, status === "REQUESTED" ? null : "EDIT");
      await denied(users.allClients);
      await denied(users.given);
    }
    await setConnection("ACTIVE", "EDIT");
    expect(await roleOf(users.given)).toBe("strategist");
  });

  it("gives nothing to people at other agencies or nowhere, and doesn't reveal the workspace", async () => {
    await denied(users.stranger);
  });

  it("gives an agency person no way into the agency's other side by slug", async () => {
    // A workspace member can't use the resolver to reach an agency they don't belong to.
    await expect(workspaceAccess(users.owner, { id: orgs.agency })).rejects.toMatchObject({ status: 404 });
  });
});
