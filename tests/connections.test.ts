import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmailVerificationToken } from "better-auth/api";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { connectRedis, disconnectRedis } from "@/infra/redis";
import { rabbitmq } from "@/infra/rabbitmq";
import { assertTopology } from "@/messaging/topology";
import { startTestServer } from "./helpers";

let server: Awaited<ReturnType<typeof startTestServer>>;
const run = randomUUID().slice(0, 8);
const origin = config.http.webOrigins[0] ?? "http://localhost:3000";
const emails = { agency: `agency+${run}@xray.test`, brand: `brand+${run}@xray.test`, client: `client+${run}@xray.test` };
const cookies: Record<string, string> = {};

async function verifiedSession(email: string, name: string) {
  await fetch(`${server.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name, email, password: "culture-map-2026" }),
  });
  const token = await createEmailVerificationToken(config.auth.secret, email);
  const res = await fetch(`${server.url}/api/auth/verify-email?token=${token}`, { redirect: "manual" });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const call = (who: string, method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json", origin, cookie: cookies[who] ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  await connectRedis();
  await rabbitmq.connect();
  await assertTopology(rabbitmq.channel(), () => rabbitmq.replacePublishChannel());
  server = await startTestServer();
  cookies.agency = await verifiedSession(emails.agency, "Tomás Reyes");
  cookies.brand = await verifiedSession(emails.brand, "Maya Osei");
});

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(emails) } }, select: { id: true, memberships: { select: { organizationId: true } } } });
  const orgIds = users.flatMap((u) => u.memberships.map((m) => m.organizationId));
  await prisma.organization.deleteMany({ where: { OR: [{ id: { in: orgIds } }, { slug: { startsWith: `sb${run}` } }] } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await server.close();
  await rabbitmq.close();
  await disconnectRedis();
  await prisma.$disconnect();
});

describe("agency and client connections", () => {
  let agencyId = "";
  let workspaceId = "";
  let connectCode = "";
  let claimToken = "";
  let codeConnectionId = "";

  it("sets up an agency and a brand workspace with a connect code", async () => {
    const agency = await call("agency", "POST", "/api/auth/organization/create", { name: "Harbor & Pine", slug: `hp${run}`, kind: "AGENCY" });
    agencyId = ((await agency.json()) as { id: string }).id;
    const brand = await call("brand", "POST", "/api/auth/organization/create", { name: "Northline Outdoor", slug: `nl${run}`, kind: "WORKSPACE" });
    workspaceId = ((await brand.json()) as { id: string }).id;
    const context = (await (await call("brand", "GET", `/api/v1/orgs/nl${run}`)).json()) as { organization: { connectCode: string } };
    connectCode = context.organization.connectCode;
    expect(connectCode).toMatch(/^NORTHLINEO-[2-9A-Z]{4}$/);
  });

  it("creates a client workspace held in trust and a pending claim", async () => {
    const res = await call("agency", "POST", `/api/v1/orgs/${agencyId}/clients`, { brandName: `SB${run} Coffee`, rivals: ["Dunkin'"], market: "US", ownerEmail: emails.client, access: "MANAGE" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { id: string; slug: string } };
    expect(body.workspace.slug).toBe(`sb${run}coffee`);

    // The raw token only exists in the email; read it back by re-issuing for the test.
    const claim = await prisma.workspaceClaim.findFirstOrThrow({ where: { workspaceId: body.workspace.id } });
    claimToken = `test-${run}`;
    const { createHash } = await import("node:crypto");
    await prisma.workspaceClaim.update({ where: { id: claim.id }, data: { tokenHash: createHash("sha256").update(claimToken).digest("hex") } });

    const list = (await (await call("agency", "GET", `/api/v1/orgs/${agencyId}/clients`)).json()) as { clients: { status: string; heldInTrust: boolean; claim: { email: string } | null; billedTo: string }[] };
    expect(list.clients[0]).toMatchObject({ status: "ACTIVE", heldInTrust: true, claim: { email: emails.client }, billedTo: "Harbor & Pine" });
  });

  it("refuses a claim from the wrong account and lets the owner claim at a lower access", async () => {
    const preview = (await (await fetch(`${server.url}/api/v1/claims/${claimToken}`)).json()) as { agency: { name: string }; requestedAccess: string; accountExists: boolean };
    expect(preview).toMatchObject({ agency: { name: "Harbor & Pine" }, requestedAccess: "MANAGE", accountExists: false });

    const wrong = await call("brand", "POST", `/api/v1/claims/${claimToken}/accept`, { access: "EDIT" });
    expect(wrong.status).toBe(403);

    cookies.client = await verifiedSession(emails.client, "Rhea Kapoor");
    const ok = await call("client", "POST", `/api/v1/claims/${claimToken}/accept`, { access: "EDIT" });
    expect(ok.status).toBe(200);
    const again = await call("client", "POST", `/api/v1/claims/${claimToken}/accept`, { access: "EDIT" });
    expect(again.status).toBe(410);

    const list = (await (await call("agency", "GET", `/api/v1/orgs/${agencyId}/clients`)).json()) as { clients: { access: string; heldInTrust: boolean; owner: { name: string } | null; billedTo: string }[] };
    expect(list.clients[0]).toMatchObject({ access: "EDIT", heldInTrust: false, owner: { name: "Rhea Kapoor" } });
  });

  it("connects to an existing workspace by code, and the brand decides", async () => {
    const bad = await call("agency", "POST", `/api/v1/orgs/${agencyId}/connections`, { code: "NOPE-0000", access: "VIEW" });
    expect(bad.status).toBe(404);
    const res = await call("agency", "POST", `/api/v1/orgs/${agencyId}/connections`, { code: connectCode.toLowerCase(), access: "EDIT" });
    expect(res.status).toBe(201);
    const twice = await call("agency", "POST", `/api/v1/orgs/${agencyId}/connections`, { code: connectCode, access: "EDIT" });
    expect(twice.status).toBe(409);

    const agencies = (await (await call("brand", "GET", `/api/v1/orgs/${workspaceId}/agencies`)).json()) as { agencies: { id: string; status: string; accessRequested: string }[] };
    expect(agencies.agencies[0]).toMatchObject({ status: "REQUESTED", accessRequested: "EDIT" });
    codeConnectionId = agencies.agencies[0]!.id;

    expect((await call("agency", "POST", `/api/v1/connections/${codeConnectionId}/decide`, { approve: true })).status).toBe(404);
    const approved = await call("brand", "POST", `/api/v1/connections/${codeConnectionId}/decide`, { approve: true, access: "VIEW" });
    expect(await approved.json()).toMatchObject({ connection: { status: "ACTIVE", access: "VIEW" } });
    const changed = await call("brand", "PATCH", `/api/v1/connections/${codeConnectionId}/access`, { access: "MANAGE" });
    expect(await changed.json()).toMatchObject({ connection: { access: "MANAGE" } });
  });

  it("lets either side end it, and the brand keeps its workspace", async () => {
    const ended = await call("agency", "POST", `/api/v1/connections/${codeConnectionId}/end`, { keepPdf: true });
    expect(await ended.json()).toMatchObject({ endedBy: "AGENCY" });
    const agencies = (await (await call("brand", "GET", `/api/v1/orgs/${workspaceId}/agencies`)).json()) as { agencies: unknown[] };
    expect(agencies.agencies).toHaveLength(0);
    expect((await call("brand", "GET", `/api/v1/orgs/nl${run}`)).status).toBe(200);
    expect((await call("agency", "POST", `/api/v1/connections/${codeConnectionId}/end`, {})).status).toBe(404);
  });

  it("rotates the workspace code for managers only", async () => {
    const res = await call("brand", "POST", `/api/v1/orgs/${workspaceId}/connect-code`);
    const { connectCode: next } = (await res.json()) as { connectCode: string };
    expect(next).not.toBe(connectCode);
    expect((await call("agency", "POST", `/api/v1/orgs/${workspaceId}/connect-code`)).status).toBe(404);
  });
});
