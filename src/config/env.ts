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
} as const;

export type AppConfig = typeof config;
