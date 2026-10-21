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
const email = `test+${randomUUID().slice(0, 8)}@xray.test`;
const otherEmail = `test+${randomUUID().slice(0, 8)}@xray.test`;
const origin = config.http.webOrigins[0] ?? "http://localhost:3000";

beforeAll(async () => {
  await connectRedis();
  await rabbitmq.connect();
  await assertTopology(rabbitmq.channel(), () => rabbitmq.replacePublishChannel());
  server = await startTestServer();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: otherEmail } });
  const user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
  if (user) {
    await prisma.organization.deleteMany({ where: { id: { in: user.memberships.map((m) => m.organizationId) } } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await server.close();
  await rabbitmq.close();
  await disconnectRedis();
  await prisma.$disconnect();
});

describe("http surface", () => {
  it("reports liveness and readiness", async () => {
    expect(await (await fetch(`${server.url}/health`)).json()).toEqual({ status: "ok" });
    const ready = await fetch(`${server.url}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ checks: { postgres: true, redis: true, rabbitmq: true } });
  });

  it("protects metrics and ops with tokens", async () => {
    expect((await fetch(`${server.url}/metrics`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/v1/ops/queues`)).status).toBe(401);
    const metrics = await fetch(`${server.url}/metrics`, { headers: { authorization: `Bearer ${config.security.metricsToken}` } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("xray_http_requests_total");
    const queues = await fetch(`${server.url}/api/v1/ops/queues`, { headers: { authorization: `Bearer ${config.security.opsToken}` } });
    expect(queues.status).toBe(200);
    expect(Object.keys(((await queues.json()) as { queues: Record<string, unknown> }).queues)).toEqual(expect.arrayContaining(["xray.dead_letters", "xray.email.send", "xray.ad.check"]));
  });

  it("rejects /me without a session", async () => {
    expect((await fetch(`${server.url}/api/v1/me`)).status).toBe(401);
  });
});

describe("auth through Better Auth", () => {
  let cookie = "";
  let orgId = "";
  const slug = `hp-${randomUUID().slice(0, 8)}`;
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(withCookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("signs up without a session until the email is confirmed", async () => {
    const res = await post("/api/auth/sign-up/email", { name: "Test Strategist", email, password: "culture-map-2026", callbackURL: "/onboarding?kind=agency" }, false);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token=");
    const signIn = await post("/api/auth/sign-in/email", { email, password: "culture-map-2026" }, false);
    expect(signIn.status).toBe(403);
    expect(((await signIn.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("signs in from the confirmation link", async () => {
    const token = await createEmailVerificationToken(config.auth.secret, email);
    const res = await fetch(`${server.url}/api/auth/verify-email?token=${token}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
  });

  it("refuses reserved and malformed workspace URLs", async () => {
    const reserved = await fetch(`${server.url}/api/v1/slugs/settings`, { headers: { cookie } });
    expect(await reserved.json()).toMatchObject({ available: false, reason: expect.stringContaining("reserved") });
    const create = await post("/api/auth/organization/create", { name: "Bad", slug: "login", kind: "AGENCY" });
    expect(create.status).toBe(400);
    expect(((await create.json()) as { code: string }).code).toBe("XRAY_INVALID_SLUG");
    const kind = await post("/api/auth/organization/create", { name: "Bad kind", slug: `bk-${randomUUID().slice(0, 8)}`, kind: "PERSONAL" });
    expect(kind.status).toBe(400);
  });

  it("creates an agency organization and /me shows the membership", async () => {
    expect(await (await fetch(`${server.url}/api/v1/slugs/${slug}`, { headers: { cookie } })).json()).toMatchObject({ available: true });
    const res = await post("/api/auth/organization/create", { name: "Harbor & Pine Test", slug, kind: "AGENCY" });
    expect(res.status).toBe(200);
    const org = (await res.json()) as { id: string };
    orgId = org.id;
    expect(org).toMatchObject({ name: "Harbor & Pine Test", kind: "AGENCY" });
    expect(await (await fetch(`${server.url}/api/v1/slugs/${slug}`, { headers: { cookie } })).json()).toMatchObject({ available: false });

    const me = await fetch(`${server.url}/api/v1/me`, { headers: { cookie } });
    const body = (await me.json()) as { user: { email: string }; memberships: unknown[]; preferences: { theme: string }; hasPassword: boolean };
    expect(body.user.email).toBe(email);
    expect(body.memberships).toEqual([expect.objectContaining({ role: "owner", kind: "AGENCY", name: "Harbor & Pine Test" })]);
    expect(body.preferences.theme).toBe("SYSTEM");
    expect(body.hasPassword).toBe(true);
  });

  it("gives members the org context and hides it from everyone else", async () => {
    const res = await fetch(`${server.url}/api/v1/orgs/${slug}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ organization: { slug, kind: "AGENCY" }, membership: { role: "owner" }, counts: { members: 1 } });
    expect((await fetch(`${server.url}/api/v1/orgs/${slug}`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/v1/orgs/not-a-real-org-${slug}`, { headers: { cookie } })).status).toBe(404);
  });

  it("updates markets and refuses join-by-domain for public mailboxes", async () => {
    const patch = (body: unknown) =>
      fetch(`${server.url}/api/v1/orgs/${orgId}/profile`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const ok = await patch({ markets: ["US", "GB"], teamSize: "11-50" });
    expect(await ok.json()).toMatchObject({ organization: { markets: ["US", "GB"], teamSize: "11-50" } });
    const bad = await patch({ joinDomain: "gmail.com" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toContain("domain you signed in with");
  });

  it("saves preferences to the profile", async () => {
    const res = await fetch(`${server.url}/api/v1/me/preferences`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ theme: "DARK", density: "COMPACT" }),
    });
    expect(await res.json()).toMatchObject({ preferences: { theme: "DARK", density: "COMPACT", reduceMotion: false } });
    const invalid = await fetch(`${server.url}/api/v1/me/preferences`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ theme: "NEON" }) });
    expect(invalid.status).toBe(400);
  });

  it("invites with a team role, never as owner, and previews the invitation publicly", async () => {
    const owner = await post("/api/auth/organization/invite-member", { email: `owner+${slug}@xray.test`, role: "owner", organizationId: orgId });
    expect(owner.status).toBe(400);
    const res = await post("/api/auth/organization/invite-member", { email: `invitee+${slug}@xray.test`, role: "strategist", organizationId: orgId });
    expect(res.status).toBe(200);
    const invitation = (await res.json()) as { id: string };
    const preview = await fetch(`${server.url}/api/v1/invitations/${invitation.id}/preview`);
    expect(await preview.json()).toMatchObject({
      role: "strategist",
      status: "pending",
      expired: false,
      accountExists: false,
      organization: { name: "Harbor & Pine Test", kind: "AGENCY" },
      inviter: { name: "Test Strategist" },
    });
  });

  it("caches the session in Redis", async () => {
    const res = await fetch(`${server.url}/api/auth/get-session`, { headers: { cookie } });
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe(email);
  });

  it("never switches accounts silently when a confirmation link is opened while signed in", async () => {
    await post("/api/auth/sign-up/email", { name: "Other Person", email: otherEmail, password: "culture-map-2026" }, false);
    const token = await createEmailVerificationToken(config.auth.secret, otherEmail);
    const res = await fetch(`${server.url}/api/auth/verify-email?token=${token}&callbackURL=%2Fonboarding`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/switch-account");
    expect(location.searchParams.get("to")).toBe(otherEmail);
    expect(location.searchParams.get("continue")).toMatch(/^\/api\/auth\/verify-email\?token=/);
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token=");
    expect((await prisma.user.findUnique({ where: { email: otherEmail } }))?.emailVerified).toBe(false);
    // Signed out, the same link confirms and signs in as usual.
    const fresh = await fetch(`${server.url}/api/auth/verify-email?token=${token}`, { redirect: "manual" });
    expect(fresh.headers.getSetCookie().join(";")).toContain("session_token=");
    expect((await prisma.user.findUnique({ where: { email: otherEmail } }))?.emailVerified).toBe(true);
  });

  it("refuses requests made for a user the session no longer belongs to", async () => {
    const me = (await (await fetch(`${server.url}/api/auth/get-session`, { headers: { cookie } })).json()) as { user: { id: string } };
    const stale = await fetch(`${server.url}/api/v1/me`, { headers: { cookie, "x-xray-user": "someone-else" } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("SESSION_CHANGED");
    const current = await fetch(`${server.url}/api/v1/me`, { headers: { cookie, "x-xray-user": me.user.id } });
    expect(current.status).toBe(200);
  });
});
