/**
 * Per-user subscription credentials, via `@flyvendedk799/ai-auth`.
 *
 * A user signs in to their OWN Claude Code / Google Antigravity plan in the browser (the same
 * PKCE flow the `claude` / `agy` CLIs run); the sealed token lives in Postgres keyed by user id.
 * This replaces the old single-machine keychain harvest, which could only ever serve whoever
 * happened to be logged in to Claude Code on the API host.
 */
import {
  AntigravityAccountStore,
  ClaudeAccountStore,
  antigravityCliOptions,
} from '@flyvendedk799/ai-auth';
import {
  PostgresCredentialStore,
  type Queryable,
  SCHEMA_SQL,
} from '@flyvendedk799/ai-auth/postgres';

export interface AiAuthStores {
  claude: ClaudeAccountStore;
  antigravity: AntigravityAccountStore;
}

/** The slice of a postgres.js client this needs (`db.$client` on a drizzle-postgres db). */
export interface PostgresJsLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown[]>;
}

export function queryableFromPostgresJs(client: PostgresJsLike): Queryable {
  return {
    async query<R>(text: string, values?: unknown[]) {
      return { rows: (await client.unsafe(text, values ?? [])) as R[] };
    },
  };
}

/** Idempotent; mirrors packages/db/drizzle/0018_ai_auth_credentials.sql. */
export async function ensureAiAuthSchema(client: PostgresJsLike): Promise<void> {
  await client.unsafe(SCHEMA_SQL);
}

export function createAiAuthStores(opts: { client: PostgresJsLike; secret: string }): AiAuthStores {
  const store = new PostgresCredentialStore({ db: queryableFromPostgresJs(opts.client) });
  const common = { store, secret: opts.secret, namespace: 'playforge' };
  return {
    claude: new ClaudeAccountStore(common),
    antigravity: new AntigravityAccountStore(common),
  };
}

export interface AntigravityModelChoice {
  id: string;
  label: string;
}

const TIERED_FLASH = 'gemini-3.8-flash-tiered';

/**
 * The models THIS login can actually call, from Cloud Code's own list. A hard-coded id that
 * the list lacks 404s every request, so the picker is fed from here rather than a constant.
 * The tiered Flash is one wire id whose effort is a request setting, so it is offered as the
 * three ids ai-auth maps back onto it.
 */
export async function listAntigravityModels(
  accessToken: string,
  projectId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<AntigravityModelChoice[]> {
  const cli = antigravityCliOptions({
    accessToken,
    refreshToken: null,
    expiresAt: 0,
    email: null,
    projectId,
  });
  const res = await fetchImpl(`${cli.baseURL}:fetchAvailableModels`, {
    method: 'POST',
    headers: cli.defaultHeaders as Record<string, string>,
    body: '{}',
  });
  if (!res.ok) throw new Error(`fetchAvailableModels ${res.status}`);
  const data = (await res.json()) as { models?: Record<string, { displayName?: string }> };
  const out: AntigravityModelChoice[] = [];
  for (const [id, info] of Object.entries(data.models ?? {})) {
    if (!id.startsWith('gemini-') || /image|embedding|-agent$/.test(id)) continue;
    if (id === TIERED_FLASH) {
      for (const level of ['high', 'medium', 'low']) {
        out.push({
          id: `gemini-3.8-flash-${level}`,
          label: `Gemini 3.8 Flash (${level[0]?.toUpperCase()}${level.slice(1)})`,
        });
      }
    } else {
      out.push({ id, label: info.displayName?.trim() || id });
    }
  }
  return out;
}
