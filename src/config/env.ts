import "dotenv/config";
import { z } from "zod";

const csv = z
  .string()
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  PORT: z.coerce.number().int().positive().default(4000),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(4001),
  PUBLIC_WEB_URL: z.url().default("http://localhost:3000"),
  WEB_ORIGINS: csv.default(["http://localhost:3000"]),

  DATABASE_URL: z.string().min(1),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  RABBITMQ_HOST: z.string().default("localhost"),
  RABBITMQ_PORT: z.coerce.number().int().positive().default(5672),
  RABBITMQ_USERNAME: z.string().min(1),
  RABBITMQ_PASSWORD: z.string().min(1),
  RABBITMQ_VHOST: z.string().min(1),

  METRICS_TOKEN: z.string().min(24),
  OPS_TOKEN: z.string().min(24),

  EMAIL_PROVIDER: z.enum(["ses", "log"]).default("log"),
  EMAIL_FROM: z
    .string()
    .trim()
    .refine((value) => /^(?:[^<>]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(value), "Use an address or 'Name <address>'"),
  EMAIL_REPLY_TO: z.union([z.email(), z.literal("")]).default(""),
  AWS_REGION: z.string().default("us-east-1"),

  // Lookups during onboarding. Empty keys switch the feature off with a friendly message.
  QLOO_API_KEY: z.string().default(""),
  QLOO_BASE: z.url().default("https://hackathon.api.qloo.com"),
  FIRECRAWL_API_KEY: z.string().default(""),

  // Ask X-Ray. A key or a compatible base URL; without either the assistant says it isn't connected.
  // ASK_PRACTICE streams a scripted answer through the real tools, for building and testing at no cost.
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_BASE_URL: z.union([z.url(), z.literal("")]).default(""),
  ASK_MODEL: z.string().default("claude-sonnet-5-5"),
  ASK_MAX_TOKENS: z.coerce.number().int().min(256).max(8192).default(1200),
  ASK_PRACTICE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  ASK_DAILY_LIMIT: z.coerce.number().int().min(1).default(40),

  // Ad check. Uploads go to Vercel Blob (private by default): the browser uploads with a short-lived
  // client token; only the backend reads the file. Without a token, ad checks say they aren't set up.
  BLOB_READ_WRITE_TOKEN: z.string().default(""),
  BLOB_ACCESS: z.enum(["private", "public"]).default("private"),
  ADCHECK_MAX_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  ADCHECK_MAX_BYTES: z.coerce.number().int().min(1_000_000).default(1_000_000_000),
  ADCHECK_KEEP_DAYS: z.coerce.number().int().min(1).default(14),

  // Gemini on Vertex AI. "practice" returns scripted, schema-valid answers at no cost; "off" disables reading.
  // Auth: a Vertex API key bound to a service account when set, otherwise Google application credentials.
  GEMINI_PROVIDER: z.enum(["vertex", "practice", "off"]).default("off"),
  GOOGLE_CLOUD_PROJECT: z.string().default(""),
  GOOGLE_CLOUD_LOCATION: z.string().default("global"),
  GOOGLE_VERTEX_API_KEY: z.string().default(""),
  GEMINI_MODEL_FAST: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_MODEL_SMART: z.string().default("gemini-3.8-flash"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  logLevel: env.LOG_LEVEL,

  http: {
    port: env.PORT,
    workerMetricsPort: env.WORKER_METRICS_PORT,
    publicWebUrl: env.PUBLIC_WEB_URL.replace(/\/+$/, ""),
    webOrigins: env.WEB_ORIGINS,
  },

  database: { url: env.DATABASE_URL },

  auth: {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL.replace(/\/+$/, ""),
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  },

  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
  },

  rabbitmq: {
    host: env.RABBITMQ_HOST,
    port: env.RABBITMQ_PORT,
    username: env.RABBITMQ_USERNAME,
    password: env.RABBITMQ_PASSWORD,
    vhost: env.RABBITMQ_VHOST,
  },

  security: {
    metricsToken: env.METRICS_TOKEN,
    opsToken: env.OPS_TOKEN,
  },

  email: {
    transport: env.EMAIL_PROVIDER,
    from: env.EMAIL_FROM,
    replyTo: env.EMAIL_REPLY_TO || undefined,
    // Credentials are never held here: the AWS SDK resolves them itself (env vars in
    // development, an IAM role or AWS profile in production).
    aws: { region: env.AWS_REGION },
  },

  qloo: { apiKey: env.QLOO_API_KEY, base: env.QLOO_BASE.replace(/\/+$/, "") },
  firecrawl: { apiKey: env.FIRECRAWL_API_KEY },
  ask: {
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    model: env.ASK_MODEL,
    maxTokens: env.ASK_MAX_TOKENS,
    practice: env.ASK_PRACTICE,
    dailyLimit: env.ASK_DAILY_LIMIT,
  },
  blob: { token: env.BLOB_READ_WRITE_TOKEN, access: env.BLOB_ACCESS },
  adCheck: { maxSeconds: env.ADCHECK_MAX_SECONDS, maxBytes: env.ADCHECK_MAX_BYTES, keepDays: env.ADCHECK_KEEP_DAYS },
  gemini: {
    provider: env.GEMINI_PROVIDER,
    project: env.GOOGLE_CLOUD_PROJECT,
    location: env.GOOGLE_CLOUD_LOCATION,
    apiKey: env.GOOGLE_VERTEX_API_KEY,
    models: { fast: env.GEMINI_MODEL_FAST, smart: env.GEMINI_MODEL_SMART },
  },
} as const;

export type AppConfig = typeof config;
