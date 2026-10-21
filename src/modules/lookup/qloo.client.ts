import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { errorDetails, logger } from "@/observability/logger";
import { cached } from "@/modules/lookup/cache";

const UNAVAILABLE = "Brand search isn't available right now. You can still add your brand by name.";

/** True when Qloo is configured; routes check this to explain rather than fail. */
export const qlooEnabled = () => Boolean(config.qloo.apiKey);

async function call(path: string, params: Record<string, string | number>, tries = 3): Promise<unknown> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `${config.qloo.base}${path}?${query}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-Api-Key": config.qloo.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body) {
        logger.warn({ path, status: res.status, error: body?.error }, "qloo request failed");
        throw new HttpError(502, UNAVAILABLE, { code: "LOOKUP_UNAVAILABLE" });
      }
      return body;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (attempt < tries) continue;
      logger.warn({ path, ...errorDetails(error) }, "qloo unreachable");
      throw new HttpError(502, UNAVAILABLE, { code: "LOOKUP_UNAVAILABLE" });
    }
  }
}

/** A cached GET against Qloo. Answers are stored in Redis and Postgres for `ttlSeconds`. */
export async function qloo<T = Record<string, unknown>>(path: string, params: Record<string, string | number>, ttlSeconds: number): Promise<T> {
  if (!qlooEnabled()) throw new HttpError(503, UNAVAILABLE, { code: "LOOKUP_DISABLED" });
  return cached(path, params, ttlSeconds, () => call(path, params)) as Promise<T>;
}
