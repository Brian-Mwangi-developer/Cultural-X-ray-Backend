import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { redis } from "@/infra/redis";
import { errorDetails, logger } from "@/observability/logger";
import { publish } from "@/messaging/publisher";
import { EXCHANGES } from "@/messaging/topology";
import { type Handler, type HandlerMap, Outcome, PermanentError } from "@/messaging/types";
import { cached, cacheKey, TTL } from "@/modules/lookup/cache";
import { prisma } from "@/infra/database";

/**
 * Reading a brand's homepage when Qloo doesn't know it. Firecrawl takes 5–20 s, so the API
 * enqueues a job and the web polls. Reads are cached per domain for 30 days.
 */

export const SITE_READ = "site.read";
const PATH = "firecrawl/v1/scrape";
const COULD_NOT_OPEN = "We couldn't open that website. Check the address, or search for your brand by name.";

export type SiteRead = { name: string; sells: string; productTypes: string[]; basedIn: string | null; sellsOnline: boolean | null; hasShops: boolean | null };
type JobState = { status: "pending" | "done" | "failed"; result?: SiteRead; message?: string };

/** "pebbleandcone.co.uk/shop" → "https://pebbleandcone.co.uk". Refuses anything that isn't a public web address. */
export function normaliseSite(input: string): { url: string; domain: string } {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new HttpError(400, "That doesn't look like a web address. Try something like yourbrand.com.", { code: "SITE_INVALID" });
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^https?:$/.test(url.protocol) || !host.includes(".") || isIP(host) || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") {
    throw new HttpError(400, "That doesn't look like a public website. Try something like yourbrand.com.", { code: "SITE_INVALID" });
  }
  return { url: `https://${url.hostname.toLowerCase()}`, domain: host };
}

const SCHEMA = {
  type: "object",
  properties: {
    brand_name: { type: "string" },
    what_it_sells: { type: "string", description: "One short phrase, e.g. 'small-batch ice cream and sorbets'" },
    product_types: { type: "array", items: { type: "string" }, description: "Up to 5 short product nouns" },
    based_in: { type: "string", description: "City and country, if stated" },
    sells_online: { type: "boolean" },
    has_physical_locations: { type: "boolean" },
  },
  required: ["brand_name", "what_it_sells", "product_types"],
};

async function firecrawl(url: string): Promise<SiteRead> {
  if (!config.firecrawl.apiKey) throw new PermanentError("firecrawl not configured");
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.firecrawl.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["json"],
      onlyMainContent: true,
      jsonOptions: { schema: SCHEMA, prompt: "From this brand's homepage, extract the brand name, what it sells in one short phrase, its main product types, where it is based, and whether it sells online and/or has shops or restaurants." },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; code?: string; error?: string; data?: { json?: Record<string, unknown> } } | null;
  const json = body?.data?.json;
  if (!res.ok || !body?.success || !json) {
    // DNS failures and blocked sites won't change on retry.
    if (res.status < 500 || /DNS|NOT_FOUND|BLOCKED|UNSUPPORTED/i.test(String(body?.code ?? body?.error))) throw new PermanentError(`firecrawl: ${body?.code ?? res.status}`);
    throw new Error(`firecrawl: ${body?.code ?? res.status}`);
  }
  const text = (v: unknown) => (typeof v === "string" && v.trim() && !/^not (specified|stated)/i.test(v.trim()) ? v.trim() : null);
  return {
    name: text(json.brand_name) ?? "",
    sells: text(json.what_it_sells) ?? "",
    productTypes: Array.isArray(json.product_types) ? json.product_types.map(String).slice(0, 5) : [],
    basedIn: text(json.based_in),
    sellsOnline: typeof json.sells_online === "boolean" ? json.sells_online : null,
    hasShops: typeof json.has_physical_locations === "boolean" ? json.has_physical_locations : null,
  };
}

const jobKey = (id: string) => `site:job:${id}`;
const setJob = (id: string, state: JobState) => redis.set(jobKey(id), JSON.stringify(state), "EX", 3600).catch(() => undefined);

/** Answer from cache straight away, or start a read and return its job id. */
export async function startSiteRead(input: string): Promise<{ jobId: string } & JobState> {
  const { url, domain } = normaliseSite(input);
  if (!config.firecrawl.apiKey) throw new HttpError(503, "Reading websites isn't available right now. Search for your brand by name, or add it as new.", { code: "SITE_DISABLED" });
  const key = cacheKey(PATH, { domain });
  const hot = redis.status === "ready" ? await redis.get(key).catch(() => null) : null;
  const row = hot ? null : await prisma.qlooCache.findUnique({ where: { key } }).catch(() => null);
  const known = hot ? (JSON.parse(hot) as SiteRead) : row && (!row.expiresAt || row.expiresAt > new Date()) ? (row.response as SiteRead) : null;
  const jobId = randomUUID();
  if (known) return { jobId, status: "done", result: known };
  await setJob(jobId, { status: "pending" });
  const published = await publish(EXCHANGES.jobs.name, SITE_READ, { jobId, url, domain }, { priority: 8 });
  if (!published.ok) throw new HttpError(503, "We couldn't start reading that website. Try again in a moment.", { code: "SITE_QUEUE" });
  return { jobId, status: "pending" };
}

export async function siteReadStatus(jobId: string): Promise<JobState> {
  const raw = await redis.get(jobKey(jobId)).catch(() => null);
  if (!raw) throw new HttpError(404, "That website read has expired. Paste the address again.", { code: "SITE_JOB_GONE" });
  return JSON.parse(raw) as JobState;
}

const jobSchema = z.object({ jobId: z.uuid(), url: z.url(), domain: z.string().min(3) });

const readSite: Handler<typeof jobSchema> = {
  schema: jobSchema,
  async handle(job, envelope) {
    try {
      const result = await cached(PATH, { domain: job.domain }, TTL.site, () => firecrawl(job.url));
      await setJob(job.jobId, result.name || result.sells ? { status: "done", result } : { status: "failed", message: COULD_NOT_OPEN });
      return Outcome.Processed;
    } catch (error) {
      const last = error instanceof PermanentError || envelope.attempt >= 2;
      if (last) {
        await setJob(job.jobId, { status: "failed", message: COULD_NOT_OPEN });
        logger.info({ domain: job.domain, ...errorDetails(error) }, "site read failed");
        return Outcome.Skipped;
      }
      throw error;
    }
  },
};

export const siteHandlers: HandlerMap = { [SITE_READ]: readSite as Handler };
