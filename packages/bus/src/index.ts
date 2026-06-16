import Redis from 'ioredis';

/**
 * @playforge/bus — the run event transport between the generation worker and
 * the API's SSE relay.
 *
 * The worker publishes each agent event to `run:{runId}`; an API instance
 * subscribes and relays to the browser over SSE. With replay, a subscriber
 * that connects *after* events were published still receives them in order —
 * this matches the production Redis Streams semantics (XADD + XRANGE replay +
 * XREAD live) and removes the publish/subscribe race that plain pub/sub has,
 * so the browser can open the SSE stream slightly after enqueue, or reconnect
 * to any API instance, without dropping events.
 *
 * InMemoryEventBus is the dev/test impl; a RedisEventBus behind the same
 * interface lands when Redis is wired.
 */

export type BusHandler = (message: unknown) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(channel: string, message: unknown): Promise<void>;
  /** Subscribe with replay: the handler first receives all messages published
   *  to the channel so far (in order), then every subsequent message until
   *  unsubscribed. */
  subscribe(channel: string, handler: BusHandler): Promise<Unsubscribe>;
}

interface ChannelState {
  history: unknown[];
  handlers: Set<BusHandler>;
}

export class InMemoryEventBus implements EventBus {
  private readonly channels = new Map<string, ChannelState>();

  private channel(name: string): ChannelState {
    let c = this.channels.get(name);
    if (!c) {
      c = { history: [], handlers: new Set() };
      this.channels.set(name, c);
    }
    return c;
  }

  async publish(channel: string, message: unknown): Promise<void> {
    const c = this.channel(channel);
    c.history.push(message);
    for (const handler of c.handlers) handler(message);
  }

  async subscribe(channel: string, handler: BusHandler): Promise<Unsubscribe> {
    const c = this.channel(channel);
    // Replay first, then go live.
    for (const message of c.history) handler(message);
    c.handlers.add(handler);
    return () => {
      c.handlers.delete(handler);
    };
  }

  /** Drop a channel's retained history once a run is fully consumed. */
  clearChannel(channel: string): void {
    this.channels.delete(channel);
  }
}

/** Channel name for a run's event stream. */
export function runChannel(runId: string): string {
  return `run:${runId}`;
}

/**
 * Production event bus backed by Redis Streams.
 *
 * Uses XADD for publish and XRANGE + XREAD(BLOCK) for subscribe-with-replay:
 *   - XRANGE '-' '+' replays all history on subscribe (catches up late joiners).
 *   - XREAD BLOCK polls for new entries after the last-seen ID.
 *
 * This matches the design intent in the comment at the top of this module:
 * any API instance can subscribe to any run's channel and get the full event
 * history, so the browser can reconnect to a different instance without
 * missing events.
 */
export class RedisEventBus implements EventBus {
  private redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  private makeClient() {
    return new Redis(this.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    const client = this.makeClient();
    try {
      await client.xadd(channel, '*', 'data', JSON.stringify(message));
    } finally {
      client.disconnect();
    }
  }

  async subscribe(channel: string, handler: BusHandler): Promise<Unsubscribe> {
    const reader = this.makeClient();
    const replayer = this.makeClient();

    type XEntry = [id: string, fields: string[]];
    type XResult = Array<[stream: string, entries: XEntry[]]>;

    // 1. Replay all history synchronously via XRANGE.
    const history = (await replayer.xrange(channel, '-', '+')) as XEntry[];
    replayer.disconnect();

    let lastId = '0-0';
    for (const [id, fields] of history) {
      const dataIdx = fields.indexOf('data');
      if (dataIdx !== -1) {
        const raw = fields[dataIdx + 1];
        if (raw !== undefined) handler(JSON.parse(raw) as unknown);
      }
      lastId = id;
    }

    // 2. Poll for new entries via blocking XREAD.
    let active = true;
    void (async () => {
      while (active) {
        let result: XResult | null = null;
        try {
          result = (await reader.xread(
            'COUNT', '100', 'BLOCK', '5000', 'STREAMS', channel, lastId,
          )) as XResult | null;
        } catch {
          if (!active) break;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (!active) break;
        if (result) {
          for (const [, entries] of result) {
            for (const [id, fields] of entries) {
              const dataIdx = fields.indexOf('data');
              if (dataIdx !== -1) {
                const raw = fields[dataIdx + 1];
                if (raw !== undefined) handler(JSON.parse(raw) as unknown);
              }
              lastId = id;
            }
          }
        }
      }
      reader.disconnect();
    })();

    return () => {
      active = false;
    };
  }
}
