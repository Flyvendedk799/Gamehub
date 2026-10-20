import { PARTY_BASE32_ALPHABET, PARTY_CODE_LENGTH } from '@playforge/shared';
import { describe, expect, it } from 'vitest';
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from './code-generator';

describe('Party Code Generator', () => {
  it('generates 6-character room codes matching safe Base32 alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(PARTY_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);

      // Verify excluded characters are NEVER generated: 0, O, 1, I, L
      expect(code).not.toMatch(/[01IILlOo]/);
      for (const char of code) {
        expect(PARTY_BASE32_ALPHABET).toContain(char);
      }
    }
  });

  it('handles collisions by checking existing room codes', () => {
    const existingCodes = new Set(['AAAAAA', 'BBBBBB', 'CCCCCC']);
    let attempts = 0;
    const isCodeInUse = (candidate: string) => {
      attempts++;
      if (attempts < 3) return true; // Simulate collision
      return existingCodes.has(candidate);
    };

    const code = generateRoomCode(isCodeInUse);
    expect(code).toHaveLength(6);
    expect(isValidRoomCode(code)).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('normalizes codes and maps confusing characters', () => {
    expect(normalizeRoomCode('  abc-def ')).toBe('ABCDEF');
    expect(normalizeRoomCode('0o1il')).toBe('QQJJJ');
    expect(normalizeRoomCode(' 23-45 67 ')).toBe('234567');
  });

  it('validates strictly valid vs invalid room codes', () => {
    expect(isValidRoomCode('234567')).toBe(true);
    expect(isValidRoomCode('ABCDEF')).toBe(true);
    expect(isValidRoomCode('23456')).toBe(false); // too short
    expect(isValidRoomCode('2345678')).toBe(false); // too long
    expect(isValidRoomCode('0BCDEF')).toBe(false); // 0 excluded
    expect(isValidRoomCode('OBCDEF')).toBe(false); // O excluded
    expect(isValidRoomCode('1BCDEF')).toBe(false); // 1 excluded
    expect(isValidRoomCode('IBCDEF')).toBe(false); // I excluded
    expect(isValidRoomCode('LBCDEF')).toBe(false); // L excluded
  });
});
