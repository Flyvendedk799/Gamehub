import { describe, expect, it } from 'vitest';
import { RtRelay } from './rt-relay.js';

describe('S11 RtRelay', () => {
  it('welcomes clients and broadcasts sync within a room', () => {
    const relay = new RtRelay();
    const inboxA: string[] = [];
    const inboxB: string[] = [];
    const a = relay.join('room1', (d) => inboxA.push(d));
    const b = relay.join('room1', (d) => inboxB.push(d));
    expect(JSON.parse(inboxA[0]!).type).toBe('welcome');
    expect(JSON.parse(inboxB[0]!).isHost).toBe(false);
    relay.handleMessage(a, JSON.stringify({ type: 'sync', key: 'score', value: 3 }));
    expect(inboxB.some((m) => m.includes('"score"'))).toBe(true);
    relay.leave(a);
    expect(relay.roomCount()).toBe(1);
    relay.leave(b);
    expect(relay.roomCount()).toBe(0);
  });
});
