/**
 * Disk-backed, auto-refreshing store for a Claude Code OAuth identity.
 *
 * Mirrors the proven Codex token-store pattern (packages/providers/src/codex/
 * token-store.ts): persist the {accessToken, refreshToken, clientId, expiresAt}
 * harvested from Claude Code, hand out a VALID access token on demand (refresh
 * silently inside the expiry buffer), and dedupe concurrent refreshes. This is
 * what lets a long generation run on a Claude SUBSCRIPTION without the
 * short-lived (hours) access token 401-ing mid-run.
 *
 * `forceRefresh()` is the "re-auth" primitive — it refreshes in place using the
 * stored refresh token, so the UI's "Re-auth" button never has to disconnect +
 * reconnect (only a genuinely revoked refresh token forces a reconnect).
 *
 * The token is the real Anthropic API credential — calls still go to
 * api.anthropic.com/v1/messages with the caller's own prompt; only the
 * billing/auth differs from a metered API key.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ERROR_CODES, PlayforgeError } from '@playforge/shared';
import { type RefreshClaudeCodeTokenResult, refreshClaudeCodeToken } from '../oauth-refresh.js';

export interface StoredClaudeAuth {
  schemaVersion: 1;
  accessToken: string;
  refreshToken: string;
  /** OAuth client id — required to refresh (Anthropic binds the token to it). */
  clientId: string;
  /** Unix-ms expiry of the access token. */
  expiresAt: number;
  email: string | null;
  scopes: string | null;
  updatedAt: number;
}

/** Refresh callback shape — defaults to the real Anthropic OAuth exchange. */
export type ClaudeRefreshFn = (input: {
  refreshToken: string;
  clientId: string;
}) => Promise<RefreshClaudeCodeTokenResult>;

export interface ClaudeTokenStoreOptions {
  filePath: string;
  refreshFn?: ClaudeRefreshFn;
  now?: () => number;
}

/** Refresh this far ahead of expiry so a turn never races the OAuth exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const NOT_CONNECTED_MSG = 'No Claude subscription connected. Connect Claude Code in settings.';

function isStoredClaudeAuth(value: unknown): value is StoredClaudeAuth {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['schemaVersion'] === 1 &&
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['clientId'] === 'string' &&
    typeof v['expiresAt'] === 'number' &&
    (v['email'] === null || typeof v['email'] === 'string') &&
    (v['scopes'] === null || typeof v['scopes'] === 'string') &&
    typeof v['updatedAt'] === 'number'
  );
}

export class ClaudeTokenStore {
  private readonly filePath: string;
  private readonly refreshFn: ClaudeRefreshFn;
  private readonly now: () => number;
  private cache: StoredClaudeAuth | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(opts: ClaudeTokenStoreOptions) {
    this.filePath = opts.filePath;
    this.refreshFn = opts.refreshFn ?? ((input) => refreshClaudeCodeToken(input));
    this.now = opts.now ?? Date.now;
  }

  async read(): Promise<StoredClaudeAuth | null> {
    let body: string;
    try {
      body = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = null;
        return null;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (cause) {
      throw new PlayforgeError(
        `Invalid Claude token store at ${this.filePath}; reconnect required`,
        ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED,
        { cause },
      );
    }
    if (!isStoredClaudeAuth(parsed)) {
      throw new PlayforgeError(
        `Invalid Claude token store at ${this.filePath}; reconnect required`,
        ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED,
      );
    }
    this.cache = parsed;
    return parsed;
  }

  /** Persist a freshly-harvested identity (connect / re-auth import path). */
  async write(auth: StoredClaudeAuth): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const body = JSON.stringify(auth, null, 2);
    // pid + UUID scoped tmp then atomic rename — same race-safety as Codex.
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
      await rename(tmpPath, this.filePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // ignore — tmp may not exist if writeFile itself failed
      }
      throw err;
    }
    this.cache = auth;
  }

  async clear(): Promise<void> {
    this.cache = null;
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** True when an identity is on disk (cheap status check for the UI). */
  async isConnected(): Promise<boolean> {
    if (this.cache === null) await this.read();
    return this.cache !== null;
  }

  /** Current identity (for the settings card), without forcing a refresh. */
  async peek(): Promise<StoredClaudeAuth | null> {
    if (this.cache === null) await this.read();
    return this.cache;
  }

  /** Hand out a valid access token, refreshing silently inside the buffer. */
  async getValidAccessToken(): Promise<string> {
    if (this.cache === null) await this.read();
    if (this.cache === null) {
      throw new PlayforgeError(NOT_CONNECTED_MSG, ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
    }
    if (this.now() >= this.cache.expiresAt - EXPIRY_BUFFER_MS) {
      return this.runRefresh();
    }
    return this.cache.accessToken;
  }

  /** Re-auth primitive: refresh in place (no disconnect needed). */
  async forceRefresh(): Promise<string> {
    if (this.cache === null) await this.read();
    if (this.cache === null) {
      throw new PlayforgeError(NOT_CONNECTED_MSG, ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
    }
    return this.runRefresh();
  }

  private runRefresh(): Promise<string> {
    if (this.refreshPromise !== null) return this.refreshPromise;
    const p = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    this.refreshPromise = p;
    return p;
  }

  private async doRefresh(): Promise<string> {
    if (this.cache === null) await this.read();
    if (this.cache === null) {
      throw new PlayforgeError(NOT_CONNECTED_MSG, ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED);
    }
    const current = this.cache;
    let next: RefreshClaudeCodeTokenResult;
    try {
      next = await this.refreshFn({
        refreshToken: current.refreshToken,
        clientId: current.clientId,
      });
    } catch (err) {
      // refreshClaudeCodeToken throws CLAUDE_CODE_REIMPORT_REQUIRED on a
      // revoked/4xx refresh token — drop the dead identity so the UI prompts
      // a reconnect instead of retrying a doomed token.
      if (err instanceof PlayforgeError && err.code === ERROR_CODES.CLAUDE_CODE_REIMPORT_REQUIRED) {
        await this.clear();
      }
      throw err;
    }
    const newAuth: StoredClaudeAuth = {
      schemaVersion: 1,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      clientId: current.clientId,
      expiresAt: next.expiresAt,
      email: current.email,
      scopes: current.scopes,
      updatedAt: this.now(),
    };
    await this.write(newAuth);
    return newAuth.accessToken;
  }
}
