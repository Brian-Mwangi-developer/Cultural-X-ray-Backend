import pino from "pino";
import { config } from "@/config/env";

// Anything that could carry a credential is redacted before it reaches stdout.
export const logger = pino({
  level: config.logLevel,
  base: { service: "xray-backend", env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "secret",
      "*.secret",
      "authorization",
      "*.authorization",
      "headers.cookie",
      "*.headers.cookie",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
});

export const errorDetails = (error: unknown) =>
  error instanceof Error ? { error: error.message, errorName: error.name } : { error: String(error) };
