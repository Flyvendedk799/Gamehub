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
