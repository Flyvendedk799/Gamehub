import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKeychainBlob, readClaudeCodeKeychainCredentials } from './keychain';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('parseKeychainBlob', () => {
  it('extracts the identity from the claudeAiOauth wrapper', () => {
    const creds = parseKeychainBlob(
      {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat-abc',
          refreshToken: 'refresh-xyz',
          expiresAt: 1781916546025,
          clientId: 'client-123',
          scopes: ['user:inference', 'user:profile'],
        },
      },
      EMPTY_ENV,
    );
    expect(creds).toEqual({
      accessToken: 'sk-ant-oat-abc',
      refreshToken: 'refresh-xyz',
      expiresAt: 1781916546025,
      oauthClientId: 'client-123',
      scopes: 'user:inference user:profile',
    });
  });

  it('accepts a top-level (unwrapped) shape', () => {
    const creds = parseKeychainBlob({ accessToken: 'sk-ant-oat-top' }, EMPTY_ENV);
    expect(creds?.accessToken).toBe('sk-ant-oat-top');
  });

  it('falls back to the env client id when the blob omits it', () => {
    const creds = parseKeychainBlob(
      { claudeAiOauth: { accessToken: 'sk-ant-oat-1', refreshToken: 'r' } },
      { PLAYFORGE_CLAUDE_OAUTH_CLIENT_ID: 'env-client' },
    );
    expect(creds?.oauthClientId).toBe('env-client');
  });

  it('returns null without an access token', () => {
    expect(parseKeychainBlob({ claudeAiOauth: { refreshToken: 'r' } }, EMPTY_ENV)).toBeNull();
    expect(parseKeychainBlob(null, EMPTY_ENV)).toBeNull();
    expect(parseKeychainBlob('nope', EMPTY_ENV)).toBeNull();
  });
});

describe('readClaudeCodeKeychainCredentials', () => {
  it('parses an injected raw blob', async () => {
    const creds = await readClaudeCodeKeychainCredentials({
      readRaw: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-z' } }),
      env: EMPTY_ENV,
    });
    expect(creds?.accessToken).toBe('sk-ant-oat-z');
  });

  it('returns null when the keychain has nothing (not logged in / non-macOS)', async () => {
    expect(await readClaudeCodeKeychainCredentials({ readRaw: async () => null })).toBeNull();
  });

  it('returns null on non-JSON keychain output', async () => {
    expect(await readClaudeCodeKeychainCredentials({ readRaw: async () => 'not-json' })).toBeNull();
  });

  // Linux / headless: no Keychain, so the identity comes from Claude Code's
  // ~/.claude/.credentials.json file. Exercised via the path override so the
  // real file (and the developer's own login) is never touched. Skipped on
  // macOS, where the Keychain read runs first and could return a real login,
  // making the file assertion non-deterministic — the file path is exactly the
  // non-darwin behavior we're validating.
  describe.skipIf(process.platform === 'darwin')('credentials file fallback', () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'pf-claude-'));
      file = join(dir, '.credentials.json');
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reads the identity from the credentials file when no readRaw is injected', async () => {
      await writeFile(
        file,
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-file', refreshToken: 'rt-1' } }),
      );
      const creds = await readClaudeCodeKeychainCredentials({
        env: { PLAYFORGE_CLAUDE_CREDENTIALS_FILE: file },
      });
      expect(creds?.accessToken).toBe('sk-ant-oat-file');
      expect(creds?.refreshToken).toBe('rt-1');
    });

    it('returns null when the credentials file is absent', async () => {
      const creds = await readClaudeCodeKeychainCredentials({
        env: { PLAYFORGE_CLAUDE_CREDENTIALS_FILE: join(dir, 'does-not-exist.json') },
      });
      expect(creds).toBeNull();
    });
  });
});
