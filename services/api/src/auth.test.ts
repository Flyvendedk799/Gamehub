import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashPassword, sessionExpiresAt, verifyPassword } from './auth';

describe('hashPassword / verifyPassword', () => {
  it('produces salt:hex format', async () => {
    const h = await hashPassword('hunter2');
    // salt = 16 bytes = 32 hex chars; hash = 64 bytes = 128 hex chars
    expect(h).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  });

  it('correct password verifies', async () => {
    const h = await hashPassword('correct-horse');
    await expect(verifyPassword('correct-horse', h)).resolves.toBe(true);
  });

  it('wrong password does not verify', async () => {
    const h = await hashPassword('correct-horse');
    await expect(verifyPassword('wrong-horse', h)).resolves.toBe(false);
  });

  it('malformed stored hash returns false without throwing', async () => {
    await expect(verifyPassword('anything', 'no-colon')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
    await expect(verifyPassword('anything', ':')).resolves.toBe(false);
  });

  it('same password produces different hashes (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same', a)).resolves.toBe(true);
    await expect(verifyPassword('same', b)).resolves.toBe(true);
  });
});

describe('generateSessionToken', () => {
  it('produces URL-safe base64url characters only', () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('has at least 32 characters (256-bit entropy)', () => {
    expect(generateSessionToken().length).toBeGreaterThanOrEqual(32);
  });

  it('tokens are unique across 200 calls', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
  });
});

describe('sessionExpiresAt', () => {
  it('is approximately 30 days in the future', () => {
    const before = Date.now();
    const exp = sessionExpiresAt();
    const after = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(exp.getTime()).toBeGreaterThanOrEqual(before + thirtyDays - 1000);
    expect(exp.getTime()).toBeLessThanOrEqual(after + thirtyDays + 1000);
  });

  it('returns a Date object', () => {
    expect(sessionExpiresAt()).toBeInstanceOf(Date);
  });
});
