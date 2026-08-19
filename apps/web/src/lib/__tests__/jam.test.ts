/**
 * Pure-function tests for the Game Jam client: seat storage, error copy, URL
 * builders, and the reconnect backoff. No DOM — `localStorage` is stubbed on
 * `globalThis` the way the node test environment expects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal in-memory localStorage so the seat store is testable under node. */
function installStorage(impl?: Partial<Storage>) {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
    ...impl,
  };
  vi.stubGlobal('window', { localStorage: storage, location: { origin: 'https://pz.test' } });
  vi.stubGlobal('localStorage', storage);
  return map;
}

describe('jam seat storage', () => {
  beforeEach(() => installStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a seat per room code', async () => {
    const { saveJamSeat, getJamSeat } = await import('../jam');
    saveJamSeat('ACDE', { playerId: 'p1', token: 't1' });
    saveJamSeat('WXYZ', { playerId: 'p2', token: 't2' });
    expect(getJamSeat('ACDE')).toEqual({ playerId: 'p1', token: 't1' });
    expect(getJamSeat('WXYZ')).toEqual({ playerId: 'p2', token: 't2' });
  });

  it('is case-insensitive on the code, so a typed lowercase link still finds the seat', async () => {
    const { saveJamSeat, getJamSeat } = await import('../jam');
    saveJamSeat('ACDE', { playerId: 'p1', token: 't1' });
    expect(getJamSeat('acde')?.token).toBe('t1');
  });

  it('returns null for a room this device has never joined', async () => {
    const { getJamSeat } = await import('../jam');
    expect(getJamSeat('QQQQ')).toBeNull();
  });

  it('clears a single room without touching the others', async () => {
    const { saveJamSeat, getJamSeat, clearJamSeat } = await import('../jam');
    saveJamSeat('ACDE', { playerId: 'p1', token: 't1' });
    saveJamSeat('WXYZ', { playerId: 'p2', token: 't2' });
    clearJamSeat('ACDE');
    expect(getJamSeat('ACDE')).toBeNull();
    expect(getJamSeat('WXYZ')).not.toBeNull();
  });

  it('ignores a corrupt stored value rather than throwing mid-room', async () => {
    const map = installStorage();
    const { getJamSeat } = await import('../jam');
    map.set('pf_jam_seat:ACDE', '{not json');
    expect(getJamSeat('ACDE')).toBeNull();
    map.set('pf_jam_seat:ACDE', '{"playerId":"p1"}');
    expect(getJamSeat('ACDE')).toBeNull();
  });

  it('survives a storage that throws (private mode) instead of breaking the join', async () => {
    installStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    const { saveJamSeat } = await import('../jam');
    expect(() => saveJamSeat('ACDE', { playerId: 'p1', token: 't1' })).not.toThrow();
  });

  it('remembers a display name across jams', async () => {
    installStorage();
    const { rememberJamName, getRememberedJamName } = await import('../jam');
    expect(getRememberedJamName()).toBe('');
    rememberJamName('Maya');
    expect(getRememberedJamName()).toBe('Maya');
  });
});

describe('jam error copy', () => {
  it('turns a known server code into one actionable sentence', async () => {
    const { JamError, describeJamError } = await import('../jam');
    expect(describeJamError(new JamError(409, 'jam_full', 'jam_full'))).toContain('8 players');
    expect(describeJamError(new JamError(403, 'jam_host_only', 'jam_host_only'))).toContain('host');
    expect(describeJamError(new JamError(409, 'jam_no_self_vote', 'x'))).toContain('own idea');
  });

  it('explains a credit failure in the host’s terms, not the API’s', async () => {
    const { JamError, describeJamError } = await import('../jam');
    expect(describeJamError(new JamError(402, 'insufficient_credits', 'x'))).toContain('credits');
  });

  it('hides server-side failures behind a plain apology', async () => {
    const { JamError, describeJamError } = await import('../jam');
    expect(describeJamError(new JamError(500, undefined, 'kaboom'))).toContain('our side');
  });

  it('handles a non-JamError without crashing the room', async () => {
    const { describeJamError } = await import('../jam');
    expect(describeJamError(new Error('offline'))).toBe('offline');
    expect(describeJamError('weird')).toBe('Something went wrong.');
  });
});

describe('jam urls', () => {
  beforeEach(() => installStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('builds a room socket url carrying the seat token', async () => {
    const { jamRoomSocketUrl } = await import('../jam');
    const url = new URL(jamRoomSocketUrl('ACDE', 'secret-token'));
    expect(url.protocol).toMatch(/^wss?:$/);
    expect(url.pathname).toBe('/v1/jams/ACDE/room');
    expect(url.searchParams.get('jamToken')).toBe('secret-token');
  });

  it('omits the token param entirely for a spectator', async () => {
    const { jamRoomSocketUrl } = await import('../jam');
    expect(new URL(jamRoomSocketUrl('ACDE', null)).searchParams.has('jamToken')).toBe(false);
  });

  it('builds an uppercase invite link off an explicit origin', async () => {
    const { jamInviteUrl } = await import('../jam');
    expect(jamInviteUrl('acde', 'https://pz.test')).toBe('https://pz.test/jam/ACDE');
  });
});

describe('jam reconnect backoff', () => {
  it('starts fast so a flaky phone rejoins immediately', async () => {
    const { jamReconnectDelay } = await import('../use-jam-room');
    expect(jamReconnectDelay(0)).toBe(500);
    expect(jamReconnectDelay(1)).toBe(1000);
  });

  it('backs off but caps, so a long jam never stalls for minutes', async () => {
    const { jamReconnectDelay } = await import('../use-jam-room');
    expect(jamReconnectDelay(10)).toBe(15_000);
    expect(jamReconnectDelay(99)).toBe(15_000);
  });

  it('is monotonic', async () => {
    const { jamReconnectDelay } = await import('../use-jam-room');
    for (let i = 0; i < 8; i++) {
      expect(jamReconnectDelay(i + 1)).toBeGreaterThanOrEqual(jamReconnectDelay(i));
    }
  });
});
