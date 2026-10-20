import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config/env";
import { prisma } from "@/infra/database";
import { connectRedis, disconnectRedis } from "@/infra/redis";
import { rabbitmq } from "@/infra/rabbitmq";
import { assertTopology } from "@/messaging/topology";
import { startTestServer } from "./helpers";

let server: Awaited<ReturnType<typeof startTestServer>>;
const email = `test+${randomUUID().slice(0, 8)}@xray.test`;
const origin = config.http.webOrigins[0] ?? "http://localhost:3000";

beforeAll(async () => {
  await connectRedis();
  await rabbitmq.connect();
  await assertTopology(rabbitmq.channel(), () => rabbitmq.replacePublishChannel());
  server = await startTestServer();
});

afterAll(async () => {
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

  it("signs up with email and returns a session cookie", async () => {
    const res = await fetch(`${server.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Test Strategist", email, password: "culture-map-2026" }),
    });
    expect(res.status).toBe(200);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
  });

  it("creates an agency organization and /me shows the membership", async () => {
    const res = await fetch(`${server.url}/api/auth/organization/create`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ name: "Harbor & Pine Test", slug: `hp-${randomUUID().slice(0, 8)}`, kind: "AGENCY" }),
    });
    expect(res.status).toBe(200);
    const org = await res.json();
    expect(org).toMatchObject({ name: "Harbor & Pine Test", kind: "AGENCY" });

    const me = await fetch(`${server.url}/api/v1/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string }; memberships: unknown[] };
    expect(body.user.email).toBe(email);
    expect(body.memberships).toEqual([expect.objectContaining({ role: "owner", kind: "AGENCY", name: "Harbor & Pine Test" })]);
  });

  it("caches the session in Redis", async () => {
    const res = await fetch(`${server.url}/api/auth/get-session`, { headers: { cookie } });
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe(email);
  });
});
