import Redis from 'ioredis';

export interface TelemetryPayload {
  runId?: string;
  topic?: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export class RedisTelemetryBridge {
  private publisher: Redis | null = null;
  private readonly subscribers = new Set<Redis>();
  private readonly redisUrl: string;
  private closed = false;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  private getPublisher(): Redis {
    if (!this.publisher) {
      this.publisher = new Redis(this.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    }
    return this.publisher;
  }

  /**
   * Publishes a telemetry event to a run-scoped channel: `telemetry:run:${runId}`
   */
  async publishRunTelemetry(
    runId: string,
    event: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.closed) return;
    const payload: TelemetryPayload = {
      runId,
      event,
      data,
      timestamp: Date.now(),
    };
    const channel = `telemetry:run:${runId}`;
    await this.getPublisher().publish(channel, JSON.stringify(payload));
  }

  /**
   * Publishes a telemetry event to a global or topic-scoped channel: `telemetry:${topic}`
   */
  async publishGlobalTelemetry(
    topic: string,
    event: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.closed) return;
    const payload: TelemetryPayload = {
      topic,
      event,
      data,
      timestamp: Date.now(),
    };
    const channel = `telemetry:${topic}`;
    await this.getPublisher().publish(channel, JSON.stringify(payload));
  }

  /**
   * Subscribes to a telemetry channel using a dedicated Redis subscriber connection.
   */
  async subscribe(
    channel: string,
    handler: (payload: TelemetryPayload) => void,
  ): Promise<() => void> {
    if (this.closed) {
      return () => {};
    }
    const sub = new Redis(this.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    this.subscribers.add(sub);

    await sub.subscribe(channel);
    sub.on('message', (_chan, msg) => {
      try {
        const parsed = JSON.parse(msg) as TelemetryPayload;
        handler(parsed);
      } catch {
        // Skip unparseable payloads
      }
    });

    return () => {
      this.subscribers.delete(sub);
      sub.disconnect();
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.publisher) {
      this.publisher.disconnect();
      this.publisher = null;
    }
    for (const sub of this.subscribers) {
      sub.disconnect();
    }
    this.subscribers.clear();
  }
}
