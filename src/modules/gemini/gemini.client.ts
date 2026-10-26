import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { config } from "@/config/env";
import { PermanentError } from "@/messaging/types";
import { errorDetails, logger } from "@/observability/logger";
import { type Attribution, recordCall } from "@/modules/usage/ai-calls";
import type { TokenUsage } from "@/modules/usage/pricing";

/**
 * Gemini on Vertex AI (`generateContent`), structured output only.
 *
 * One zod schema per stage does both jobs: it becomes the JSON schema Gemini must answer in, and
 * it checks the answer before anything is saved. Every call that gets an answer, or a refusal, is
 * recorded with its tokens and cost against the person and workspace (ai_call).
 *
 * GEMINI_PROVIDER=practice returns the stage's scripted answer at no cost (parsed by the same
 * schema, so it can't drift from it). "off" refuses to read.
 */

export type Tier = "fast" | "smart";
export type Level = "LOW" | "MEDIUM" | "HIGH";
export type Provider = "vertex" | "practice" | "off";

/** A video, the whole of it or one clip. The clip cuts both frames and sound. */
export type VideoPart = { video: Buffer; mimeType?: string; clip?: { startMs: number; endMs: number }; fps?: number };
export type Part = string | VideoPart;

export type GenerateRequest<S extends z.ZodType> = {
  stage: string;
  tier: Tier;
  parts: Part[];
  schema: S;
  /** What practice mode answers. Must pass the schema. */
  practice: z.input<S>;
  thinking?: Level;
  resolution?: Level;
  maxOutputTokens?: number;
  attribution: Attribution;
};

export type GenerateResult<T> = { json: T; usage: TokenUsage; model: string; provider: "vertex" | "practice" };

/** Gemini declined on policy. Never retried: the check fails with a plain message and is logged for review. */
export class PolicyRefusal extends PermanentError {
  constructor(readonly stage: string, readonly reason: string) {
    super(`Gemini refused the ${stage} pass (${reason})`);
    this.name = "PolicyRefusal";
  }
}

/** Vertex refused the request itself (a bad schema or input). Not retried; the details go to the logs, not to people. */
export class GeminiRequestError extends PermanentError {
  constructor(readonly stage: string, readonly detail: string) {
    super(`Vertex AI rejected the ${stage} request`);
    this.name = "GeminiRequestError";
  }
}

/** Reading is switched off, or Vertex isn't set up (no project, no credentials). */
export class GeminiUnavailable extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUnavailable";
  }
}

const TRIES = 3;
const TIMEOUT_MS = 180_000;
const REFUSED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

export const modelFor = (tier: Tier) => config.gemini.models[tier];

/**
 * zod's JSON schema, trimmed to what Vertex accepts: no `$schema`, no number ranges and no list
 * caps. Vertex rejects a schema it finds too complex with a bare 400 "invalid argument", and caps and
 * ranges are what tip it over (26 Oct 2026: a capped list of ranged times in the audio pass; capped
 * lists nested in a capped list for the re-cuts). The limits still hold: `clampLists` trims long
 * lists to their cap, then the zod schema checks the answer.
 */
export function forGemini(schema: z.ZodType): Record<string, unknown> {
  const DROP = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems"]);
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROP.has(key)) continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

type Json = { type?: string | string[]; properties?: Record<string, Json>; items?: Json; maxItems?: number; anyOf?: Json[] };

/** Trim every list in an answer to the cap its schema sets (the first items are kept). */
export function clampLists(value: unknown, schema: z.ZodType): unknown {
  const walk = (v: unknown, s: Json | undefined): unknown => {
    if (!s) return v;
    if (Array.isArray(v)) {
      const kept = s.maxItems !== undefined ? v.slice(0, s.maxItems) : v;
      return kept.map((x) => walk(x, s.items));
    }
    if (v && typeof v === "object" && s.properties) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, s.properties![k])]));
    }
    return v;
  };
  return walk(value, z.toJSONSchema(schema) as Json);
}

/** What an HTTP failure means: try again, a policy refusal, or a mistake retrying won't fix. */
export function classify(status: number, body: string): "retry" | "refused" | "fail" {
  if (status === 408 || status === 429 || status >= 500) return "retry";
  if (status === 403 && /violat|acceptable use|prohibited|policy|suspended/i.test(body)) return "refused";
  return "fail";
}

type VertexAnswer = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
};

/** The answer's text (thoughts left out), its token use, and whether it was blocked. */
export function readAnswer(body: VertexAnswer): { text: string; usage: TokenUsage; refused: string | null } {
  const m = body.usageMetadata ?? {};
  const usage = { inputTokens: m.promptTokenCount ?? 0, outputTokens: m.candidatesTokenCount ?? 0, thoughtTokens: m.thoughtsTokenCount ?? 0, cachedTokens: m.cachedContentTokenCount ?? 0 };
  const first = body.candidates?.[0];
  const finish = first?.finishReason ?? "";
  const refused = body.promptFeedback?.blockReason ?? (REFUSED_FINISH.has(finish) ? finish : null);
  const text = (first?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  return { text, usage, refused };
}

const base64 = new WeakMap<Buffer, string>();
function encoded(video: Buffer) {
  let data = base64.get(video);
  if (!data) base64.set(video, (data = video.toString("base64")));
  return data;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

function toParts(parts: Part[]) {
  return parts.map((part) =>
    typeof part === "string"
      ? { text: part }
      : {
          inlineData: { mimeType: part.mimeType ?? "video/mp4", data: encoded(part.video) },
          ...(part.clip || part.fps
            ? { videoMetadata: { ...(part.clip ? { startOffset: seconds(part.clip.startMs), endOffset: seconds(part.clip.endMs) } : {}), ...(part.fps ? { fps: part.fps } : {}) } }
            : {}),
        },
  );
}

let auth: GoogleAuth | null = null;
async function authHeaders(): Promise<Record<string, string>> {
  if (config.gemini.apiKey) return { "x-goog-api-key": config.gemini.apiKey };
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  try {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("no access token");
    return { authorization: `Bearer ${token}` };
  } catch (error) {
    throw new GeminiUnavailable(`Vertex AI credentials are missing (${errorDetails(error).error})`);
  }
}

function endpoint(model: string) {
  const { project, location } = config.gemini;
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 2 s, 8 s, ~20 s with jitter, or what Retry-After asks for (capped at a minute). */
const backoff = (attempt: number, retryAfter: string | null) =>
  retryAfter && Number(retryAfter) > 0 ? Math.min(Number(retryAfter) * 1000, 60_000) : [2_000, 8_000, 20_000][attempt - 1]! * (0.75 + Math.random() * 0.5);

async function viaVertex<S extends z.ZodType>(req: GenerateRequest<S>): Promise<GenerateResult<z.output<S>>> {
  if (!config.gemini.project) throw new GeminiUnavailable("GOOGLE_CLOUD_PROJECT is not set");
  const model = modelFor(req.tier);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: toParts(req.parts) }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: forGemini(req.schema),
      thinkingConfig: { thinkingLevel: req.thinking ?? "LOW" },
      ...(req.resolution ? { mediaResolution: `MEDIA_RESOLUTION_${req.resolution}` } : {}),
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
    },
  });
  const record = (outcome: "ok" | "refused" | "error", started: number, usage?: TokenUsage) =>
    recordCall({ ...req.attribution, provider: "vertex", model, stage: req.stage, usage, durationMs: Date.now() - started, outcome });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(endpoint(model), { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof GeminiUnavailable) throw error;
      lastError = error; // network or timeout: worth another go
      if (attempt < TRIES) await wait(backoff(attempt, null));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const kind = classify(res.status, text);
      await record(kind === "refused" ? "refused" : "error", started);
      if (kind === "refused") throw new PolicyRefusal(req.stage, `HTTP ${res.status}`);
      lastError = new Error(`Vertex AI ${res.status} on ${req.stage}: ${text.slice(0, 300)}`);
      if (kind === "fail") {
        logger.error({ stage: req.stage, model, status: res.status, detail: text.slice(0, 1000) }, "gemini: request rejected");
        throw res.status === 401 || res.status === 403 ? new GeminiUnavailable(String((lastError as Error).message)) : new GeminiRequestError(req.stage, text.slice(0, 1000));
      }
      if (attempt < TRIES) await wait(backoff(attempt, res.headers.get("retry-after")));
      continue;
    }

    const answer = readAnswer((await res.json()) as VertexAnswer);
    if (answer.refused) {
      await record("refused", started, answer.usage);
      throw new PolicyRefusal(req.stage, answer.refused);
    }
    // A malformed answer is paid for like any other, so it is recorded before being checked.
    await record("ok", started, answer.usage);
    try {
      return { json: req.schema.parse(clampLists(JSON.parse(answer.text), req.schema)), usage: answer.usage, model, provider: "vertex" };
    } catch (error) {
      lastError = error;
      logger.warn({ stage: req.stage, model, attempt, ...errorDetails(error) }, "gemini: answer did not match the schema");
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Vertex AI failed on ${req.stage}`);
}

async function viaPractice<S extends z.ZodType>(req: GenerateRequest<S>): Promise<GenerateResult<z.output<S>>> {
  const started = Date.now();
  const json = req.schema.parse(req.practice);
  const model = `practice:${modelFor(req.tier)}`;
  await recordCall({ ...req.attribution, provider: "practice", model, stage: req.stage, durationMs: Date.now() - started, outcome: "ok" });
  return { json, usage: { inputTokens: 0, outputTokens: 0 }, model, provider: "practice" };
}

/** Ask Gemini for one structured answer. Throws PolicyRefusal / GeminiUnavailable (both permanent) or a retryable error. */
export function generate<S extends z.ZodType>(req: GenerateRequest<S>, provider: Provider = config.gemini.provider): Promise<GenerateResult<z.output<S>>> {
  if (provider === "practice") return viaPractice(req);
  if (provider === "vertex") return viaVertex(req);
  return Promise.reject(new GeminiUnavailable("Ad reading is switched off (GEMINI_PROVIDER=off)"));
}
