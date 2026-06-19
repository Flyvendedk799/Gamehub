/**
 * Harvest a Claude Code OAuth identity from the local macOS Keychain.
 *
 * Claude Code stores its subscription OAuth blob under the generic-password
 * service "Claude Code-credentials". Because Gamehub's API runs locally on the
 * same Mac where `claude` is logged in, we can read that blob, persist the
 * {accessToken, refreshToken, clientId, expiresAt} into a ClaudeTokenStore, and
 * keep it fresh via the OAuth refresh exchange — so generation runs on the
 * subscription against the REAL Anthropic API.
 *
 * macOS-only: on any other platform (or when `claude` isn't logged in) the read
 * returns null and the caller surfaces "connect Claude Code first". The `readRaw`
 * + `env` seams are injectable so the parser is unit-testable without a keychain.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The macOS Keychain generic-password service name Claude Code writes to. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Env fallback for the OAuth client id when the blob omits it (Anthropic binds
 *  the refresh token to the Claude Code client id). */
const CLIENT_ID_ENV = 'PLAYFORGE_CLAUDE_OAUTH_CLIENT_ID';

export interface ClaudeKeychainCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Unix-ms expiry of the access token, when present. */
  expiresAt?: number;
  oauthClientId?: string;
  scopes?: string;
}

async function readRawFromKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    const trimmed = stdout.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    // security exits 44 ("could not be found") / 51 ("interaction not allowed").
    return null;
  }
}

/** Parse Claude Code's keychain JSON. The token lives under `claudeAiOauth`
 *  (newer CLI) or at the top level. Pure + injectable for testing. */
export function parseKeychainBlob(
  blob: unknown,
  env: NodeJS.ProcessEnv,
): ClaudeKeychainCredentials | null {
  if (typeof blob !== 'object' || blob === null) return null;
  const root = blob as Record<string, unknown>;
  const inner =
    typeof root['claudeAiOauth'] === 'object' && root['claudeAiOauth'] !== null
      ? (root['claudeAiOauth'] as Record<string, unknown>)
      : root;

  const accessToken = inner['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  const out: ClaudeKeychainCredentials = { accessToken };

  const refreshToken = inner['refreshToken'];
  if (typeof refreshToken === 'string' && refreshToken.length > 0) out.refreshToken = refreshToken;

  const expiresAt = inner['expiresAt'];
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
    out.expiresAt = expiresAt;
  }

  const inBlobClientId = inner['clientId'] ?? inner['client_id'];
  const envClientId = env[CLIENT_ID_ENV];
  if (typeof inBlobClientId === 'string' && inBlobClientId.length > 0) {
    out.oauthClientId = inBlobClientId;
  } else if (typeof envClientId === 'string' && envClientId.length > 0) {
    out.oauthClientId = envClientId;
  }

  const scopes = inner['scopes'];
  if (typeof scopes === 'string' && scopes.length > 0) {
    out.scopes = scopes;
  } else if (Array.isArray(scopes)) {
    const joined = scopes.filter((s): s is string => typeof s === 'string').join(' ');
    if (joined.length > 0) out.scopes = joined;
  }

  return out;
}

/** Read + parse the Claude Code identity from the macOS Keychain, or null when
 *  unavailable (non-macOS, not logged in, locked keychain). */
export async function readClaudeCodeKeychainCredentials(opts?: {
  readRaw?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeKeychainCredentials | null> {
  const readRaw = opts?.readRaw ?? readRawFromKeychain;
  const raw = await readRaw();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseKeychainBlob(parsed, opts?.env ?? process.env);
}
