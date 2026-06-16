import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, runChannel } from './index';

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
