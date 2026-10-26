import "dotenv/config";

/**
 * Tests get their own RabbitMQ virtual host (`xray-test`), so a job they publish never reaches a
 * dev worker running against the real Gemini and Qloo: tests drive handlers themselves. Created
 * through the management API (idempotent), with the app's own credentials.
 */
export const TEST_VHOST = "xray-test";

export default async function setup() {
  const user = process.env.RABBITMQ_USERNAME;
  const pass = process.env.RABBITMQ_PASSWORD;
  if (!user || !pass) return;
  const base = `http://127.0.0.1:${process.env.RABBITMQ_MANAGEMENT_HOST_PORT ?? "15682"}/api`;
  const headers = { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`, "content-type": "application/json" };
  const put = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!res.ok && res.status !== 204) throw new Error(`RabbitMQ management ${path}: HTTP ${res.status}`);
  };
  await put(`/vhosts/${TEST_VHOST}`, { description: "Backend tests (vitest)" });
  await put(`/permissions/${TEST_VHOST}/${encodeURIComponent(user)}`, { configure: ".*", write: ".*", read: ".*" });
}
