/**
 * Fresh subscription tokens for long-running jobs.
 *
 * The API resolves a user's Claude Code / Antigravity access token when the job is QUEUED and
 * puts it in the job payload. Those tokens live about an hour (Google) to eight (Claude), and a
 * build runs for tens of minutes, can wait in the queue, and is replayed from the same payload
 * when a worker restarts - so a run could start with a dead token and fail with a 401 halfway
 * through ("Antigravity error: 401"). The worker therefore asks ai-auth for the CURRENT token
 * every turn, for the job's own user. ai-auth refreshes an aged-out token and writes it back.
 */
import { AntigravityAccountStore, ClaudeAccountStore } from '@flyvendedk799/ai-auth';
import { PostgresCredentialStore } from '@flyvendedk799/ai-auth/postgres';
import { looksLikeClaudeOAuthToken } from '@playforge/providers';

/** The slice of a postgres.js client this needs (`db.$client` on a drizzle-postgres db). */
export interface PostgresJsLike {
  unsafe(text: string, values?: unknown[]): Promise<unknown[]>;
}

export interface TokenJob {
  userId: string | undefined;
  wire: string | undefined;
  provider: string;
  apiKey: string;
}

export function createSubscriptionTokenSource(opts: { client: PostgresJsLike; secret: string }) {
  const store = new PostgresCredentialStore({
    db: {
      async query<R>(text: string, values?: unknown[]) {
        return { rows: (await opts.client.unsafe(text, values ?? [])) as R[] };
      },
    },
  });
  // Same namespace and secret the API stores them under.
  const common = { store, secret: opts.secret, namespace: 'playforge' };
  const claude = new ClaudeAccountStore(common);
  const antigravity = new AntigravityAccountStore(common);

  return {
    /**
     * A getter for the CURRENT token of this job's subscription, or undefined when the job does
     * not run on one (platform credits, a pasted API key, Codex).
     */
    forJob(job: TokenJob): (() => Promise<string>) | undefined {
      const userId = job.userId;
      if (userId === undefined || userId.length === 0) return undefined;
      if (job.wire === 'antigravity-cloudcode') return () => antigravity.token(userId);
      if (job.provider === 'anthropic' && looksLikeClaudeOAuthToken(job.apiKey)) {
        return () => claude.token(userId);
      }
      return undefined;
    },
  };
}
