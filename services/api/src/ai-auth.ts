/**
 * Per-user subscription credentials, via `@flyvendedk799/ai-auth`.
 *
 * A user signs in to their OWN Claude Code / Google Antigravity plan in the browser (the same
 * PKCE flow the `claude` / `agy` CLIs run); the sealed token lives in Postgres keyed by user id.
 * This replaces the old single-machine keychain harvest, which could only ever serve whoever
 * happened to be logged in to Claude Code on the API host.
 */
import { AntigravityAccountStore, ClaudeAccountStore } from '@flyvendedk799/ai-auth';
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
