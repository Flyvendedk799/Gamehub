import {
  AntigravityAccountStore,
  ClaudeAccountStore,
  MemoryCredentialStore,
} from '@flyvendedk799/ai-auth';
import { InMemoryEventBus } from '@playforge/bus';
import { describe, expect, it } from 'vitest';
import { InMemoryAccountRepo } from './account-repo';
import { HeaderAuthenticator } from './auth';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import { buildServer } from './server';

function makeApp() {
  const store = new MemoryCredentialStore();
  const common = { store, secret: 'test-secret', namespace: 'playforge' };
  const claude = new ClaudeAccountStore(common);
  const antigravity = new AntigravityAccountStore(common);
  const accountRepo = new InMemoryAccountRepo();
  const app = buildServer({
    repo: new InMemoryProjectRepo(),
    auth: new HeaderAuthenticator(),
    bus: new InMemoryEventBus(),
    runRepo: new InMemoryRunRepo(),
    enqueue: async () => {},
    accountRepo,
    claudeAccounts: claude,
    antigravityAccounts: antigravity,
  });
  return { app, claude, antigravity, accountRepo };
}

const as = (user: string) => ({ 'x-user-id': user });

describe('per-user subscription login (ai-auth)', () => {
  it('requires a session on every login route', async () => {
    const { app } = makeApp();
    for (const url of ['/v1/auth/claude-code', '/v1/auth/antigravity']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `${url}/login` })).statusCode).toBe(401);
    }
  });

  it('starts a browser login and hands back only the URL', async () => {
    const { app } = makeApp();
    const claude = await app.inject({
      method: 'POST',
      url: '/v1/auth/claude-code/login',
      headers: as('alice'),
    });
    expect(claude.statusCode).toBe(200);
    const claudeBody = claude.json<{ url: string; verifier?: string }>();
    expect(claudeBody.url).toMatch(/^https:\/\//);
    expect(claudeBody.verifier).toBeUndefined();

    const agy = await app.inject({
      method: 'POST',
      url: '/v1/auth/antigravity/login',
      headers: as('alice'),
    });
    expect(agy.statusCode).toBe(200);
    // The prod OAuth client (not Dogfood) is the default for browser login.
    expect(agy.json<{ url: string }>().url).toContain('1071006060591-');
  });

  it('keeps each user’s connection separate and reports it in account settings', async () => {
    const { app, antigravity, accountRepo } = makeApp();
    accountRepo.ensureUser('alice');
    accountRepo.ensureUser('bob');
    await antigravity.save('alice', {
      accessToken: 'ya29.a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      email: 'a@example.com',
      isDogfood: false,
    });

    const alice = await app.inject({
      method: 'GET',
      url: '/v1/auth/antigravity',
      headers: as('alice'),
    });
    const bob = await app.inject({
      method: 'GET',
      url: '/v1/auth/antigravity',
      headers: as('bob'),
    });
    expect(alice.json<{ connected: boolean }>().connected).toBe(true);
    expect(bob.json<{ connected: boolean }>().connected).toBe(false);

    const settings = await app.inject({
      method: 'GET',
      url: '/v1/account/settings',
      headers: as('alice'),
    });
    const providers = settings.json<{
      providers: Array<{ provider: string; configured: boolean }>;
    }>().providers;
    expect(providers.find((p) => p.provider === 'antigravity-subscription')?.configured).toBe(true);
    expect(providers.find((p) => p.provider === 'claude-subscription')?.configured).toBe(false);

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/antigravity',
      headers: as('alice'),
    });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/antigravity',
      headers: as('alice'),
    });
    expect(after.json<{ connected: boolean }>().connected).toBe(false);
  });
});
