import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, RedisEventBus, runChannel, safeParseStreamData } from './index';

/**
 * A minimal in-memory stand-in for an ioredis client. Records xadd calls and
 * tracks disconnects so we can assert the bus's connection model without a
 * live Redis. Only the methods RedisEventBus.publish touches are implemented.
 */
class FakeRedis {
  disconnected = false;
  readonly added: Array<{ channel: string; data: string }> = [];
  async xadd(channel: string, _star: string, _field: string, data: string): Promise<string> {
    this.added.push({ channel, data });
    return '1-0';
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

/**
 * Build a RedisEventBus whose private `makeClient` factory is swapped for one
 * that hands out FakeRedis instances, so the connection model is testable
 * without a live Redis. The created clients are collected so a test can prove
 * the publisher is a single shared connection rather than one-per-publish.
 */
function makeFakeRedisBus(): { bus: RedisEventBus; clients: FakeRedis[] } {
  const clients: FakeRedis[] = [];
  const bus = new RedisEventBus('redis://test');
  // The factory is a private impl detail; override it via an index cast so the
  // test exercises the real publish()/close() against fakes.
  (bus as unknown as { makeClient: () => FakeRedis }).makeClient = () => {
    const c = new FakeRedis();
    clients.push(c);
    return c;
  };
  return { bus, clients };
}

describe('InMemoryEventBus', () => {
  it('delivers live messages to a subscriber', async () => {
    const bus = new InMemoryEventBus();
    const seen: unknown[] = [];
    await bus.subscribe('c', (m) => seen.push(m));
    await bus.publish('c', { a: 1 });
    await bus.publish('c', { a: 2 });
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('replays prior messages to a late subscriber (no lost events)', async () => {
    const bus = new InMemoryEventBus();
    await bus.publish('c', 'first');
    await bus.publish('c', 'second');
    const seen: unknown[] = [];
    await bus.subscribe('c', (m) => seen.push(m));
    await bus.publish('c', 'third');
    expect(seen).toEqual(['first', 'second', 'third']);
  });

  it('skips history with { replay: false } and delivers only live messages', async () => {
    const bus = new InMemoryEventBus();
    await bus.publish('c', 'old');
    const seen: unknown[] = [];
    await bus.subscribe('c', (m) => seen.push(m), { replay: false });
    await bus.publish('c', 'new');
    expect(seen).toEqual(['new']);
  });

  it('isolates channels and stops after unsubscribe', async () => {
    const bus = new InMemoryEventBus();
    const seen: unknown[] = [];
    const unsub = await bus.subscribe('a', (m) => seen.push(m));
    await bus.publish('b', 'other');
    await bus.publish('a', 'mine');
    unsub();
    await bus.publish('a', 'after-unsub');
    expect(seen).toEqual(['mine']);
  });

  it('runChannel namespaces by run id', () => {
    expect(runChannel('abc')).toBe('run:abc');
  });
});

describe('RedisEventBus connection model', () => {
  it('publishes many events through ONE shared publisher connection', async () => {
    const { bus, clients } = makeFakeRedisBus();
    await bus.publish('run:1', { type: 'text_delta', text: 'a' });
    await bus.publish('run:1', { type: 'text_delta', text: 'b' });
    await bus.publish('run:2', { type: 'run_complete' });

    // The old impl opened (and disconnected) a fresh client per publish; the
    // shared-publisher impl creates exactly one client for all three.
    expect(clients).toHaveLength(1);
    const pub = clients[0]!;
    expect(pub.disconnected).toBe(false); // stays live across publishes
    expect(pub.added).toEqual([
      { channel: 'run:1', data: JSON.stringify({ type: 'text_delta', text: 'a' }) },
      { channel: 'run:1', data: JSON.stringify({ type: 'text_delta', text: 'b' }) },
      { channel: 'run:2', data: JSON.stringify({ type: 'run_complete' }) },
    ]);
  });

  it('safeParseStreamData parses valid JSON and skips (without throwing) corrupt entries', () => {
    const ok = safeParseStreamData(JSON.stringify({ type: 'text_delta', text: 'hi' }));
    expect(ok).toEqual({ ok: true, value: { type: 'text_delta', text: 'hi' } });

    // A corrupt entry (truncated/garbage) must never throw — that would reject
    // the whole subscribe() replay or kill the live XREAD loop, stranding the
    // stream. It logs and returns { ok: false } so the caller skips it. (C3)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = safeParseStreamData('{not valid json');
    expect(bad).toEqual({ ok: false });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('close() disconnects the shared publisher and is idempotent', async () => {
    const { bus, clients } = makeFakeRedisBus();
    await bus.publish('run:1', { type: 'run_complete' });
    expect(clients).toHaveLength(1);

    await bus.close();
    expect(clients[0]!.disconnected).toBe(true);

    // Idempotent: a second close (SIGTERM then SIGINT) must not throw.
    await expect(bus.close()).resolves.toBeUndefined();
  });
});
