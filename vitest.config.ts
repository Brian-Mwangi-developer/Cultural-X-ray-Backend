import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Tests never call Vertex (cost, rate limits): Gemini answers come from practice mode. Their
    // jobs go to their own RabbitMQ vhost (tests/global-setup.ts), so no dev worker picks them up.
    globalSetup: ["./tests/global-setup.ts"],
    env: { EMAIL_PROVIDER: "log", NODE_ENV: "test", GEMINI_PROVIDER: "practice", RABBITMQ_VHOST: "xray-test" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
