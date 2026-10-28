import { config } from "@/config/env";
import { HttpError } from "@/http/errors";
import { errorDetails, logger } from "@/observability/logger";
import { cached } from "@/modules/lookup/cache";
import { recordQlooCall } from "@/modules/usage/meter";

const UNAVAILABLE = "Brand search isn't available right now. You can still add your brand by name.";

/** True when Qloo is configured; routes check this to explain rather than fail. */
export const qlooEnabled = () => Boolean(config.qloo.apiKey);

/**
 * Lookups (a person is typing) get two tries of 9 s, so an answer, or a plain "taking longer" message,
 * always comes back before the web's proxy gives up at 30 s. Measured 28 October: Qloo's town search
 * took 2–30 s per new query, and three 12 s tries ran past the proxy as a bare 502. Map builds and the
 * worker pass their own, longer budget.
 */
export type QlooOptions = { timeoutMs?: number; tries?: number };

const SLOW = "Search is taking longer than usual. Keep typing, or try again in a moment.";

async function call(path: string, params: Record<string, string | number>, { timeoutMs = 9_000, tries = 2 }: QlooOptions): Promise<unknown> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `${config.qloo.base}${path}?${query}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-Api-Key": config.qloo.apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
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
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      logger.warn({ path, timedOut, ...errorDetails(error) }, timedOut ? "qloo too slow" : "qloo unreachable");
      // 408 rather than 5xx: the web shows our words for 4xx, and this is worth saying plainly.
      throw timedOut ? new HttpError(408, SLOW, { code: "LOOKUP_SLOW" }) : new HttpError(502, UNAVAILABLE, { code: "LOOKUP_UNAVAILABLE" });
    }
  }
}

/** A cached GET against Qloo. Answers are stored in Redis and Postgres for `ttlSeconds`. */
export async function qloo<T = Record<string, unknown>>(path: string, params: Record<string, string | number>, ttlSeconds: number, options: QlooOptions = {}): Promise<T> {
  if (!qlooEnabled()) throw new HttpError(503, UNAVAILABLE, { code: "LOOKUP_DISABLED" });
  // Only a call that goes out to Qloo counts against the account; our cache answers for free.
  let fetched = false;
  try {
    return (await cached(path, params, ttlSeconds, () => {
      fetched = true;
      return call(path, params, options);
    })) as T;
  } finally {
    void recordQlooCall(path, !fetched);
  }
}
