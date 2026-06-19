import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES, PlayforgeError } from '@playforge/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { RefreshClaudeCodeTokenResult } from '../oauth-refresh';
import { ClaudeTokenStore, type StoredClaudeAuth } from './token-store';

let counter = 0;
const tmpPath = (): string => join(tmpdir(), `pf-claude-store-${process.pid}-${counter++}.json`);

const baseAuth = (over: Partial<StoredClaudeAuth> = {}): StoredClaudeAuth => ({
  schemaVersion: 1,
  accessToken: 'sk-ant-oat-current',
  refreshToken: 'refresh-1',
  clientId: 'client-1',
  expiresAt: 9_999_999_999_999,
  email: 'dev@example.com',
  scopes: 'user:inference',
  updatedAt: 1,
  ...over,
});

const stores: ClaudeTokenStore[] = [];
afterEach(async () => {
  await Promise.all(stores.map((s) => s.clear().catch(() => {})));
  stores.length = 0;
});

function makeStore(opts: {
  refresh?: (input: {
    refreshToken: string;
    clientId: string;
  }) => Promise<RefreshClaudeCodeTokenResult>;
  now?: () => number;
}): ClaudeTokenStore {
  const s = new ClaudeTokenStore({
    filePath: tmpPath(),
    ...(opts.refresh ? { refreshFn: opts.refresh } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  stores.push(s);
  return s;
}

describe('ClaudeTokenStore', () => {
  it('returns the cached access token when not near expiry', async () => {
    const store = makeStore({});
    await store.write(baseAuth());
    expect(await store.getValidAccessToken()).toBe('sk-ant-oat-current');
  });

  it('refreshes silently inside the expiry buffer and persists the new token', async () => {
    let refreshes = 0;
    const store = makeStore({
      now: () => 1_000_000,
      refresh: async () => {
        refreshes++;
        return { accessToken: 'sk-ant-oat-fresh', refreshToken: 'refresh-2', expiresAt: 9e15 };
      },
    });
    await store.write(baseAuth({ expiresAt: 1_000_000 + 1000 })); // ~now → within buffer
    expect(await store.getValidAccessToken()).toBe('sk-ant-oat-fresh');
    expect(refreshes).toBe(1);
    // persisted: a second read sees the rotated refresh token
    const peeked = await store.peek();
    expect(peeked?.refreshToken).toBe('refresh-2');
  });

  it('forceRefresh refreshes in place (the re-auth primitive)', async () => {
    const store = makeStore({
      refresh: async () => ({
        accessToken: 'sk-ant-oat-reauth',
        refreshToken: 'refresh-3',
        expiresAt: 9e15,
      }),
    });
    await store.write(baseAuth());
    expect(await store.forceRefresh()).toBe('sk-ant-oat-reauth');
  });

  it('throws REIMPORT_REQUIRED when nothing is connected', async () => {
    const store = makeStore({});
    await expect(store.getValidAccessToken()).rejects.toMatchObject({
      code: ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED,
    });
    expect(await store.isConnected()).toBe(false);
  });

  it('drops a dead identity when the refresh token is revoked', async () => {
    const store = makeStore({
      now: () => 1_000_000,
      refresh: async () => {
        throw new PlayforgeError('rejected', ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
      },
    });
    await store.write(baseAuth({ expiresAt: 1_000_000 }));
    await expect(store.getValidAccessToken()).rejects.toMatchObject({
      code: ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED,
    });
    // identity cleared so the UI prompts a reconnect rather than retrying
    expect(await store.isConnected()).toBe(false);
  });

  it('clear() removes the identity', async () => {
    const store = makeStore({});
    await store.write(baseAuth());
    expect(await store.isConnected()).toBe(true);
    await store.clear();
    expect(await store.isConnected()).toBe(false);
  });
});
