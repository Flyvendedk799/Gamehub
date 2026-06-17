import { describe, expect, it } from 'vitest';
import { encodeVarUint, readVarUint } from '../varint';

describe('varint codec (y-websocket framing)', () => {
  it('round-trips small values in a single byte', () => {
    for (const n of [0, 1, 42, 127]) {
      const enc = encodeVarUint(n);
      expect(enc.length).toBe(1);
      const [dec, next] = readVarUint(enc, 0);
      expect(dec).toBe(n);
      expect(next).toBe(1);
    }
  });

  it('uses multiple bytes past 0x7f', () => {
    const enc = encodeVarUint(128);
    expect(enc.length).toBe(2);
    const [dec] = readVarUint(enc, 0);
    expect(dec).toBe(128);
  });

  it('round-trips larger values', () => {
    for (const n of [128, 255, 300, 16384, 1_000_000]) {
      const enc = encodeVarUint(n);
      const [dec] = readVarUint(enc, 0);
      expect(dec).toBe(n);
    }
  });

  it('reads from an offset and reports the next position', () => {
    const a = encodeVarUint(300);
    const b = encodeVarUint(7);
    const combined = new Uint8Array([...a, ...b]);
    const [first, mid] = readVarUint(combined, 0);
    expect(first).toBe(300);
    expect(mid).toBe(a.length);
    const [second, end] = readVarUint(combined, mid);
    expect(second).toBe(7);
    expect(end).toBe(combined.length);
  });
});
