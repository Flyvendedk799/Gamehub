/**
 * Harvest a Codex / ChatGPT subscription identity from the local `codex` CLI's
 * auth file (~/.codex/auth.json), the symmetric counterpart to Claude's keychain
 * harvest. The file holds `{ tokens: { access_token, refresh_token, id_token,
 * account_id } }` when logged in via the ChatGPT subscription (OPENAI_API_KEY
 * absent). Gamehub re-reads it (rather than running its own OAuth refresh) so the
 * `codex` CLI's session is never broken — the CLI keeps the token fresh itself.
 *
 * Returns a Codex `TokenSet`; expiry is decoded from the access-token JWT (the
 * file stores no `expires_in`). macOS/Linux only insofar as the `codex` CLI
 * stores creds there; the read seam is injectable for tests.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type TokenSet, decodeJwtClaims, extractAccountId } from './oauth.js';

const DEFAULT_AUTH_FILE = join(homedir(), '.codex', 'auth.json');

function expiresAtFromJwt(accessToken: string): number {
  const claims = decodeJwtClaims(accessToken);
  const exp = claims?.['exp'];
  return typeof exp === 'number' && exp > 0 ? exp * 1000 : Date.now() + 60 * 60 * 1000;
}

export async function readCodexAuthFile(opts?: {
  readRaw?: () => Promise<string | null>;
}): Promise<TokenSet | null> {
  const readRaw =
    opts?.readRaw ??
    (async () => {
      try {
        return await readFile(process.env['CODEX_AUTH_FILE'] ?? DEFAULT_AUTH_FILE, 'utf8');
      } catch {
        return null;
      }
    });
  const raw = await readRaw();
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const tokens =
    typeof root['tokens'] === 'object' && root['tokens'] !== null
      ? (root['tokens'] as Record<string, unknown>)
      : root;

  const accessToken = tokens['access_token'] ?? tokens['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  const refreshToken = tokens['refresh_token'] ?? tokens['refreshToken'];
  const idTokenRaw = tokens['id_token'] ?? tokens['idToken'];
  const idToken = typeof idTokenRaw === 'string' ? idTokenRaw : '';
  const directAccountId = tokens['account_id'] ?? tokens['accountId'];
  const accountId =
    typeof directAccountId === 'string' && directAccountId.length > 0
      ? directAccountId
      : idToken
        ? extractAccountId(idToken)
        : null;

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    idToken,
    accountId,
    expiresAt: expiresAtFromJwt(accessToken),
  };
}
