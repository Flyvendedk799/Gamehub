/**
 * Harvest a Claude Code OAuth identity from the local Claude Code login.
 *
 * Claude Code stores its subscription OAuth blob two ways depending on host:
 *   - macOS: the Keychain generic-password service "Claude Code-credentials".
 *   - Linux / headless / macOS-without-keyring: a plaintext file at
 *     ~/.claude/.credentials.json.
 * Because Gamehub's API runs on the same machine where `claude` is logged in, we
 * read whichever exists, persist the {accessToken, refreshToken, clientId,
 * expiresAt} into a ClaudeTokenStore, and keep it fresh by re-reading the local
 * login — so generation runs on the subscription against the REAL Anthropic API,
 * whether the box is a developer's Mac or a Linux VPS.
 *
 * When neither source has a login the read returns null and the caller surfaces
 * "connect Claude Code first". The `readRaw` + `env` seams are injectable so the
 * parser is unit-testable without a keychain or a real credentials file.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** The macOS Keychain generic-password service name Claude Code writes to. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Override for the Linux/headless credentials file path (tests + non-standard
 *  homes). Defaults to ~/.claude/.credentials.json. */
const CREDENTIALS_FILE_ENV = 'PLAYFORGE_CLAUDE_CREDENTIALS_FILE';

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

/** Path to Claude Code's plaintext credentials file (Linux / headless / macOS
 *  keyring-less). Honors the env override so a service running as a different
 *  user, or tests, can point at an explicit file. */
function credentialsFilePath(env: NodeJS.ProcessEnv): string {
  const override = env[CREDENTIALS_FILE_ENV];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.claude', '.credentials.json');
}

/** Read Claude Code's credentials file. Returns null when it doesn't exist or is
 *  empty — the same "no login here" signal the keychain reader gives. */
async function readRawFromFile(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const raw = await readFile(credentialsFilePath(env), 'utf8');
    return raw.trim().length === 0 ? null : raw;
  } catch {
    // ENOENT (never logged in) / EACCES (wrong user) — both mean "no login".
    return null;
  }
}

/** Default raw reader: the macOS Keychain first, then the plaintext file. On
 *  Linux the keychain read is a no-op (returns null), so this resolves to the
 *  file; on macOS the keychain wins but a keyring-less setup still falls back to
 *  the file. Either way the shape handed to the parser is identical. */
async function readRawDefault(env: NodeJS.ProcessEnv): Promise<string | null> {
  const fromKeychain = await readRawFromKeychain();
  if (fromKeychain !== null) return fromKeychain;
  return readRawFromFile(env);
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

/** Read + parse the Claude Code identity from the local login — the macOS
 *  Keychain or the ~/.claude/.credentials.json file — or null when neither has a
 *  login (not logged in, locked keychain, wrong user). */
export async function readClaudeCodeKeychainCredentials(opts?: {
  readRaw?: () => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeKeychainCredentials | null> {
  const env = opts?.env ?? process.env;
  const readRaw = opts?.readRaw ?? (() => readRawDefault(env));
  const raw = await readRaw();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseKeychainBlob(parsed, env);
}
