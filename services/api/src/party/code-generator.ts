import { randomInt } from 'node:crypto';
import { PARTY_BASE32_ALPHABET, PARTY_CODE_LENGTH } from '@playforge/shared';

const ROOM_CODE_REGEX = new RegExp(`^[${PARTY_BASE32_ALPHABET}]{${PARTY_CODE_LENGTH}}$`);

/**
 * Generates a 6-character Base32 room code using safe alphabet:
 * '23456789ABCDEFGHJKMNPQRSTUVWXYZ' (strictly excluding 0, O, 1, I, L).
 * Includes collision check hook against active rooms.
 */
export function generateRoomCode(
  isCodeInUse?: (code: string) => boolean,
  maxAttempts = 100,
): string {
  const alphabetLen = PARTY_BASE32_ALPHABET.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = '';
    for (let i = 0; i < PARTY_CODE_LENGTH; i++) {
      const idx = randomInt(0, alphabetLen);
      code += PARTY_BASE32_ALPHABET[idx];
    }

    if (!isCodeInUse || !isCodeInUse(code)) {
      return code;
    }
  }

  throw new Error(`Failed to generate a unique room code after ${maxAttempts} attempts`);
}

/**
 * Normalizes user-entered room codes: trims whitespace, strips hyphens/spaces,
 * converts to uppercase, and maps easily-confused characters to safe alphabet equivalents:
 * 0 -> Q, O -> Q, 1 -> J, I -> J, L -> J.
 */
export function normalizeRoomCode(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/[0O]/g, 'Q')
    .replace(/[1IL]/g, 'J');
}

/**
 * Checks whether a room code strictly conforms to the 6-character safe Base32 alphabet.
 */
export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_REGEX.test(code);
}
