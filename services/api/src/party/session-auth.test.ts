import { describe, expect, it } from 'vitest';
import { createSessionToken, signSessionToken, verifySessionToken } from './session-auth';

describe('Party Session Auth (HMAC-SHA256)', () => {
  const secret = 'test-secret-key-1234567890';
  const claims = {
    roomId: '11111111-1111-4111-8111-111111111111',
    roomCode: '234ABC',
    memberId: '22222222-2222-4222-8222-222222222222',
    role: 'HOST' as const,
    issuedAt: Date.now(),
    nonce: 'random-nonce-value',
  };

  it('signs and verifies session tokens correctly', () => {
    const token = signSessionToken(claims, secret);
    expect(typeof token).toBe('string');
    expect(token).toContain('.');

    const verified = verifySessionToken(token, secret);
    expect(verified).not.toBeNull();
    expect(verified?.roomId).toBe(claims.roomId);
    expect(verified?.roomCode).toBe(claims.roomCode);
    expect(verified?.memberId).toBe(claims.memberId);
    expect(verified?.role).toBe(claims.role);
    expect(verified?.nonce).toBe(claims.nonce);
  });

  it('rejects tampered session tokens', () => {
    const token = signSessionToken(claims, secret);
    const [payload, signature] = token.split('.');

    // Tamper with payload
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, role: 'SPECTATOR' })).toString(
      'base64url',
    );
    const tamperedToken = `${tamperedPayload}.${signature}`;

    expect(verifySessionToken(tamperedToken, secret)).toBeNull();
  });

  it('rejects tokens signed with a different secret', () => {
    const token = signSessionToken(claims, secret);
    const wrongSecret = 'different-secret-0987654321';
    expect(verifySessionToken(token, wrongSecret)).toBeNull();
  });

  it('rejects malformed or empty tokens', () => {
    expect(verifySessionToken('')).toBeNull();
    expect(verifySessionToken('not-a-token')).toBeNull();
    expect(verifySessionToken('part1.part2.part3')).toBeNull();
    expect(verifySessionToken('invalidbase64!.invalidsig!')).toBeNull();
  });

  it('creates valid tokens with createSessionToken helper', () => {
    const token = createSessionToken(
      claims.roomId,
      claims.roomCode,
      claims.memberId,
      'PLAYER',
      secret,
    );
    const verified = verifySessionToken(token, secret);
    expect(verified).not.toBeNull();
    expect(verified?.roomId).toBe(claims.roomId);
    expect(verified?.roomCode).toBe(claims.roomCode);
    expect(verified?.memberId).toBe(claims.memberId);
    expect(verified?.role).toBe('PLAYER');
    expect(verified?.nonce).toBeDefined();
    expect(typeof verified?.issuedAt).toBe('number');
  });
});
