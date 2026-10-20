import amqplib, { type ChannelModel, type ConfirmChannel } from "amqplib";
import { config } from "@/config/env";
import { errorDetails, logger } from "@/observability/logger";
import { dependencyUp } from "@/observability/metrics";

type Listener = () => void | Promise<void>;

/**
 * One connection, one confirm channel for publishing and one per consumer.
 * Reconnects with backoff and replays registered listeners (topology, consumers)
 * so a broker restart heals without restarting the process.
 */
class RabbitMQ {
  private connection: ChannelModel | null = null;
  private publishChannel: ConfirmChannel | null = null;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly onReconnect: Listener[] = [];

  private get url(): string {
    const { host, port, username, password, vhost } = config.rabbitmq;
    return `amqp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(vhost)}?heartbeat=30`;
  }

  async connect(maxAttempts = 20, delayMs = 2_000): Promise<void> {
    if (this.connection && this.publishChannel) return;
    this.closing = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const connection = await amqplib.connect(this.url, { timeout: 10_000 });
        connection.on("error", (error: Error) => logger.warn(errorDetails(error), "rabbitmq connection error"));
        connection.on("close", () => this.handleClose());
        this.connection = connection;
        this.publishChannel = await this.openChannel();
        dependencyUp.set({ dependency: "rabbitmq" }, 1);
        logger.info({ attempt }, "rabbitmq connected");
        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        logger.warn({ attempt, maxAttempts, ...errorDetails(error) }, "rabbitmq not ready, retrying");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async openChannel(): Promise<ConfirmChannel> {
    if (!this.connection) throw new Error("RabbitMQ is not connected");
    const channel = await this.connection.createConfirmChannel();
    channel.on("error", (error: Error) => logger.warn(errorDetails(error), "rabbitmq channel error"));
    return channel;
  }

  channel(): ConfirmChannel {
    if (!this.publishChannel) throw new Error("RabbitMQ is not connected");
    return this.publishChannel;
  }

  tryChannel(): ConfirmChannel | null {
    return this.publishChannel;
  }

  async replacePublishChannel(): Promise<ConfirmChannel> {
    this.publishChannel = await this.openChannel();
    return this.publishChannel;
  }

  whenReconnected(listener: Listener): void {
    this.onReconnect.push(listener);
  }

  isConnected(): boolean {
    return Boolean(this.connection && this.publishChannel);
  }

  private handleClose(): void {
    this.connection = null;
    this.publishChannel = null;
    dependencyUp.set({ dependency: "rabbitmq" }, 0);
    if (this.closing) return;
    logger.warn("rabbitmq connection lost, reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(1);
        for (const listener of this.onReconnect) await listener();
        logger.info("rabbitmq reconnected and listeners restored");
      } catch (error) {
        logger.error(errorDetails(error), "rabbitmq reconnect failed");
        this.scheduleReconnect();
      }
    }, 3_000);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.publishChannel?.close();
      await this.connection?.close();
    } catch (error) {
      logger.warn(errorDetails(error), "rabbitmq close error");
    } finally {
      this.connection = null;
      this.publishChannel = null;
      dependencyUp.set({ dependency: "rabbitmq" }, 0);
    }
  }
}

export const rabbitmq = new RabbitMQ();
