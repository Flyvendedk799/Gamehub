import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARTY_ACCENT_COLORS,
  PARTY_AVATARS,
  PARTY_BASE32_ALPHABET,
  PARTY_CODE_LENGTH,
  PARTY_EMOJIS,
  PARTY_RATE_LIMITS,
  SOUND_BITES,
  clearPartySession,
  getPartyProfile,
  getPartySession,
  normalizeRoomCode,
  sanitizeDisplayName,
  savePartyProfile,
  savePartySession,
} from '../party/party-types';

function installStorage() {
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
  };
  vi.stubGlobal('window', {
    localStorage: storage,
    sessionStorage: storage,
    location: { origin: 'https://gamehub.gg' },
  });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  return map;
}

describe('Party Mode Types & Normalization', () => {
  beforeEach(() => installStorage());
  afterEach(() => vi.unstubAllGlobals());

  describe('normalizeRoomCode', () => {
    it('normalizes input to uppercase and clamps to 6 characters', () => {
      expect(normalizeRoomCode('234567')).toBe('234567');
      expect(normalizeRoomCode('abc234def')).toBe('ABC234');
    });

    it('auto-maps confusing characters: 0->Q, O->Q, 1->J, I->J, L->J', () => {
      // 0 and O -> Q
      expect(normalizeRoomCode('0O2345')).toBe('QQ2345');
      // 1, I, L -> J
      expect(normalizeRoomCode('1IL234')).toBe('JJJ234');
      // Mixed confusing string
      expect(normalizeRoomCode('01IOLL')).toBe('QJJQJJ');
    });

    it('strips any characters not in Base32 alphabet and handles empty string', () => {
      expect(normalizeRoomCode('')).toBe('');
      expect(normalizeRoomCode('!@#$%^')).toBe('');
      expect(normalizeRoomCode('A-B-C-D-E-F')).toBe('ABCDEF');
    });

    it('verifies safe Base32 alphabet excludes confusing characters 0, O, 1, I, L', () => {
      expect(PARTY_CODE_LENGTH).toBe(6);
      expect(PARTY_BASE32_ALPHABET).toHaveLength(31);
      expect(PARTY_BASE32_ALPHABET).not.toContain('0');
      expect(PARTY_BASE32_ALPHABET).not.toContain('O');
      expect(PARTY_BASE32_ALPHABET).not.toContain('1');
      expect(PARTY_BASE32_ALPHABET).not.toContain('I');
      expect(PARTY_BASE32_ALPHABET).not.toContain('L');
    });
  });

  describe('sanitizeDisplayName', () => {
    it('trims and limits handle to 20 chars', () => {
      const res = sanitizeDisplayName('   SuperGamer2000XYZ123456789   ');
      expect(res.cleanName.length).toBeLessThanOrEqual(20);
      expect(res.cleanName).toBe('SuperGamer2000XYZ123');
      expect(res.hasProfanity).toBe(false);
    });

    it('flags profanity and replaces with asterisks', () => {
      const res = sanitizeDisplayName('bad shit here');
      expect(res.hasProfanity).toBe(true);
      expect(res.cleanName).toBe('bad *** here');
    });
  });

  describe('Party Session & Profile Persistence', () => {
    it('round-trips party session', () => {
      const session = {
        roomId: 'room-123',
        roomCode: '234567',
        memberId: 'mem-456',
        sessionToken: 'token-789',
        isHost: true,
      };

      savePartySession(session);
      expect(getPartySession('234567')).toEqual(session);
      expect(getPartySession('non-existent')).toBeNull();

      clearPartySession('234567');
      expect(getPartySession('234567')).toBeNull();
    });

    it('round-trips user profile', () => {
      const profile = {
        displayName: 'GraceDev',
        avatarId: 'cat',
        avatarColor: '#10b981',
      };
      savePartyProfile(profile);
      expect(getPartyProfile()).toEqual(profile);
    });
  });

  describe('Party Constants & Assets', () => {
    it('defines 24 avatars and 8 accent colors', () => {
      expect(PARTY_AVATARS).toHaveLength(24);
      expect(PARTY_ACCENT_COLORS).toHaveLength(8);
      expect(PARTY_ACCENT_COLORS).toContain('#6366f1');
      expect(PARTY_ACCENT_COLORS).toContain('#10b981');
    });

    it('defines 6 sound bites and 7 emojis', () => {
      expect(SOUND_BITES).toHaveLength(6);
      const soundIds = SOUND_BITES.map((s) => s.id);
      expect(soundIds).toEqual(['airhorn', 'sad_trombone', 'cheer', 'drumroll', 'fanfare', 'bruh']);

      expect(PARTY_EMOJIS).toHaveLength(7);
      expect(PARTY_EMOJIS).toContain('🔥');
      expect(PARTY_EMOJIS).toContain('GG');
    });

    it('verifies rate limits', () => {
      expect(PARTY_RATE_LIMITS.MAX_EMOJIS_PER_SEC).toBe(3);
      expect(PARTY_RATE_LIMITS.SOUND_COOLDOWN_MS).toBe(4000);
      expect(PARTY_RATE_LIMITS.PING_INTERVAL_MS).toBe(5000);
      expect(PARTY_RATE_LIMITS.DISCONNECT_GRACE_MS).toBe(60000);
    });
  });
});
