import { createServer } from "node:http";
import { config } from "@/config/env";
import { tokenMatches } from "@/http/middleware";
import { errorDetails, logger } from "@/observability/logger";
import { registry } from "@/observability/metrics";
import { rabbitmq } from "@/infra/rabbitmq";
import { startWorkerSide } from "@/messaging/index";
import { connectCore, handleShutdown } from "@/runtime/lifecycle";

// Workers serve no traffic, only /health and token-protected /metrics for Prometheus.
function startOpsServer() {
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(rabbitmq.isConnected() ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: rabbitmq.isConnected() ? "ok" : "degraded" }));
      return;
    }
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    if (req.url === "/metrics" && bearer && tokenMatches(bearer, config.security.metricsToken)) {
      res.writeHead(200, { "Content-Type": registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    res.writeHead(req.url === "/metrics" ? 401 : 404);
    res.end();
  });
  server.listen(config.http.workerMetricsPort);
  return server;
}

async function main(): Promise<void> {
  await connectCore();
  await startWorkerSide();
  const ops = startOpsServer();
  handleShutdown("worker", [{ name: "ops-http", close: () => new Promise((resolve) => ops.close(resolve)) }]);
  logger.info({ metricsPort: config.http.workerMetricsPort }, "worker running");
}

main().catch((error) => {
  logger.fatal(errorDetails(error), "worker failed to start");
  process.exit(1);
});
