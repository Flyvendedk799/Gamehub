import { describe, expect, it } from 'vitest';
import { readCodexAuthFile } from './auth-file';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('readCodexAuthFile', () => {
  it('harvests tokens from the codex auth.json shape', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = jwt({ exp });
    const id = jwt({ email: 'dev@example.com' });
    const raw = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: access,
        refresh_token: 'rt.1.abc',
        id_token: id,
        account_id: 'acc-123',
      },
    });
    const creds = await readCodexAuthFile({ readRaw: async () => raw });
    expect(creds?.accessToken).toBe(access);
    expect(creds?.refreshToken).toBe('rt.1.abc');
    expect(creds?.accountId).toBe('acc-123');
    expect(creds?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns null when not logged in / file absent', async () => {
    expect(await readCodexAuthFile({ readRaw: async () => null })).toBeNull();
  });

  it('returns null on non-JSON', async () => {
    expect(await readCodexAuthFile({ readRaw: async () => 'nope' })).toBeNull();
  });

  it('returns null without an access token', async () => {
    expect(
      await readCodexAuthFile({
        readRaw: async () => JSON.stringify({ tokens: { refresh_token: 'x' } }),
      }),
    ).toBeNull();
  });
});
