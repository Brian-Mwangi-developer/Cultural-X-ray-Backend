import type { Server } from "node:http";
import { config } from "@/config/env";
import { createApp } from "@/http/app";
import { errorDetails, logger } from "@/observability/logger";
import { startPublisherSide } from "@/messaging/index";
import { connectCore, handleShutdown } from "@/runtime/lifecycle";
import { attachVoice } from "@/modules/voice/voice.relay";

async function main(): Promise<void> {
  await connectCore();
  await startPublisherSide();

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(config.http.port, () => resolve(s));
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  // Talk to X-Ray: the voice socket rides on the same server (voice.relay.ts).
  attachVoice(server);

  handleShutdown("api", [{ name: "http", close: () => new Promise((resolve) => server.close(resolve)) }]);
  logger.info({ port: config.http.port, authBaseUrl: config.auth.baseUrl }, "api listening");
}

main().catch((error) => {
  logger.fatal(errorDetails(error), "api failed to start");
  process.exit(1);
});
