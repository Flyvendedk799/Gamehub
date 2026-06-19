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

export interface SubscribeOptions {
  /**
   * When false, skip the historical replay and deliver only messages published
   * AFTER this subscription. Used by the SSE relay, which now backfills a run's
   * history from the durable `run_events` table and only needs the bus for the
   * live tail — replaying the bus history too would double every event. Default
   * true (replay-on-subscribe, the original behaviour). */
  replay?: boolean;
}

export interface EventBus {
  publish(channel: string, message: unknown): Promise<void>;
  /** Subscribe with replay (default): the handler first receives all messages
   *  published to the channel so far (in order), then every subsequent message
   *  until unsubscribed. Pass `{ replay: false }` for live-only delivery. */
  subscribe(channel: string, handler: BusHandler, opts?: SubscribeOptions): Promise<Unsubscribe>;
  /**
   * Release any underlying transport resources (Redis connections). Called on
   * graceful API/worker shutdown so the process can exit cleanly instead of
   * hanging on open sockets. No-op for the in-memory impl.
   */
  close(): Promise<void>;
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

  async subscribe(
    channel: string,
    handler: BusHandler,
    opts?: SubscribeOptions,
  ): Promise<Unsubscribe> {
    const c = this.channel(channel);
    // Replay first (unless live-only requested), then go live.
    if (opts?.replay !== false) {
      for (const message of c.history) handler(message);
    }
    c.handlers.add(handler);
    return () => {
      c.handlers.delete(handler);
    };
  }

  /** Drop a channel's retained history once a run is fully consumed. */
  clearChannel(channel: string): void {
    this.channels.delete(channel);
  }

  /** No-op — the in-memory bus holds no external connections. */
  async close(): Promise<void> {
    /* nothing to release */
  }
}

/** Channel name for a run's event stream. */
export function runChannel(runId: string): string {
  return `run:${runId}`;
}

/**
 * Parse a stream entry's JSON payload, returning a sentinel-free result. A
 * single corrupt entry must never throw: in the XRANGE replay it would reject
 * the whole `subscribe()`; in the live XREAD loop it would escape the `try`
 * (which only wraps `xread`) and kill the polling loop, silently stranding the
 * stream. We log and skip the bad entry instead.
 */
export function safeParseStreamData(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[bus] skipping unparseable stream entry:',
      err instanceof Error ? err.message : err,
    );
    return { ok: false };
  }
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
  private readonly redisUrl: string;

  /**
   * ONE persistent publisher connection, shared across all publish() calls.
   *
   * Previously publish() opened a fresh Redis client per event and disconnected
   * it in `finally`. Under load that churns a connection for every agent token
   * delta, spiking `connected_clients` and burning connect/teardown latency on
   * the hot path. XADD is non-blocking, so a single long-lived client serves
   * every publish safely. Created lazily so constructing the bus (e.g. in tests
   * or a no-publish API instance) doesn't open a socket until first use.
   *
   * Subscribers MUST NOT share this client: a blocking XREAD would monopolise
   * the connection and stall every publish. Each subscribe() gets its own
   * dedicated reader (see below).
   */
  private publisher: Redis | null = null;

  /** Live subscriber readers, so close() can tear them down on shutdown. */
  private readonly readers = new Set<Redis>();

  private closed = false;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  private makeClient(): Redis {
    return new Redis(this.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
  }

  /** Lazily create + reuse the single shared publisher connection. */
  private getPublisher(): Redis {
    if (this.publisher === null) {
      this.publisher = this.makeClient();
    }
    return this.publisher;
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.getPublisher().xadd(channel, '*', 'data', JSON.stringify(message));
  }

  async subscribe(
    channel: string,
    handler: BusHandler,
    opts?: SubscribeOptions,
  ): Promise<Unsubscribe> {
    // A dedicated client per subscription: the blocking XREAD below must never
    // share the publisher (it would block every publish for the BLOCK window).
    const reader = this.makeClient();
    this.readers.add(reader);

    type XEntry = [id: string, fields: string[]];
    type XResult = Array<[stream: string, entries: XEntry[]]>;

    let lastId = '0-0';
    if (opts?.replay === false) {
      // Live-only: start from the stream's current end ('$' means "only entries
      // added after this XREAD"), skipping the XRANGE replay entirely.
      lastId = '$';
    } else {
      // 1. Replay all history synchronously via XRANGE.
      const replayer = this.makeClient();
      const history = (await replayer.xrange(channel, '-', '+')) as XEntry[];
      replayer.disconnect();
      for (const [id, fields] of history) {
        const dataIdx = fields.indexOf('data');
        if (dataIdx !== -1) {
          const raw = fields[dataIdx + 1];
          if (raw !== undefined) {
            const parsed = safeParseStreamData(raw);
            if (parsed.ok) handler(parsed.value);
          }
        }
        lastId = id;
      }
    }

    // 2. Poll for new entries via blocking XREAD.
    let active = true;
    void (async () => {
      while (active) {
        let result: XResult | null = null;
        try {
          result = (await reader.xread(
            'COUNT',
            '100',
            'BLOCK',
            '5000',
            'STREAMS',
            channel,
            lastId,
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
                if (raw !== undefined) {
                  const parsed = safeParseStreamData(raw);
                  if (parsed.ok) handler(parsed.value);
                }
              }
              lastId = id;
            }
          }
        }
      }
      this.readers.delete(reader);
      reader.disconnect();
    })();

    return () => {
      active = false;
    };
  }

  /**
   * Release the shared publisher and every live subscriber reader. Idempotent —
   * a double close() (e.g. SIGTERM then SIGINT) is a no-op.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.publisher !== null) {
      this.publisher.disconnect();
      this.publisher = null;
    }
    for (const reader of this.readers) reader.disconnect();
    this.readers.clear();
  }
}
