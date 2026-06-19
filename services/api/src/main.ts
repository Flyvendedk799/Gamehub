import { type EventBus, InMemoryEventBus, RedisEventBus } from '@playforge/bus';
import { createDb, schema } from '@playforge/db';
import { LocalFsBlobStore, SnapshotStore } from '@playforge/storage';
/**
 * Live API entry point.
 *
 * When REDIS_URL is set: events flow through RedisEventBus; generation jobs
 * are enqueued to BullMQ for the dedicated worker service to consume.
 *
 * When REDIS_URL is absent (dev without Redis): falls back to InMemoryEventBus
 * + in-process generation (enqueueRun called directly).
 *
 * Required env vars:
 *   DATABASE_URL        Postgres connection string (postgres://...)
 *   PLATFORM_API_KEY    Anthropic/OpenAI key for the platform account
 *
 * Optional:
 *   REDIS_URL           Redis connection string (default: none → in-process mode)
 *   PLATFORM_MODEL_ID   e.g. o4-mini (default)
 *   PLATFORM_PROVIDER   e.g. openai (default)
 *   PORT                HTTP listen port (default 3191)
 *   CORS_ORIGINS        Space-separated browser app origins allowed to call the API
 *   BLOB_DIR            local blob-store root (default: .playforge-blobs)
 *   API_KEY_ENCRYPTION_SECRET  Secret for BYOK key encryption (falls back to PLATFORM_API_KEY)
 */
import { Queue } from 'bullmq';
import { enqueueRun } from '../../worker/src/queue';
import { DrizzleAccountRepo } from './account-repo';
import { SessionAuthenticator } from './auth';
import { BrowserJobQueue } from './browser-queue';
import { type CreditPurchaseProvider, MockCreditProvider } from './credit-purchase';
import {
  DrizzleChatRepo,
  DrizzleProjectRepo,
  DrizzleRunRepo,
  DrizzleSnapshotRepo,
} from './drizzle-repos';
import { ConsoleEmailTransport, type EmailPort } from './email';
import { DrizzleHubRepo } from './hub-repo';
import { DrizzlePublishRepo } from './publish-repo';
import { type EnqueueFn, buildServer } from './server';

/** Run cost in credits — must match server.ts and worker/main.ts. */
const CREDITS_PER_RUN = 10;
export const DEFAULT_API_PORT = 3191;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port) || 6379 };
  } catch {
    return { host: '127.0.0.1', port: 6379 };
  }
}

/**
 * Parse a positive-integer env var, falling back to `fallback` for unset OR
 * malformed values. A typo like `MAX_RUN_TOKENS=abc` → `NaN` would otherwise
 * silently disable the run token ceiling (`used > NaN` is always false), and a
 * bad `PORT`/`MAX_CONCURRENT_RUNS` would misconfigure the server. (M1)
 */
export function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[playforge-api] ignoring invalid numeric env value ${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(n);
}

async function main() {
  const databaseUrl = requireEnv('DATABASE_URL');
  const platformApiKey = requireEnv('PLATFORM_API_KEY');
  const modelId = process.env['PLATFORM_MODEL_ID'] ?? 'o4-mini';
  const modelProvider = process.env['PLATFORM_PROVIDER'] ?? 'openai';
  const platformModel = { provider: modelProvider, modelId };
  const apiKeyEncryptionSecret = process.env['API_KEY_ENCRYPTION_SECRET'] ?? platformApiKey;
  const port = parsePositiveIntEnv(process.env['PORT'], DEFAULT_API_PORT);
  const redisUrl = process.env['REDIS_URL'];
  const corsOrigins = process.env['CORS_ORIGINS'];
  const blobDir = process.env['BLOB_DIR'] ?? '.playforge-blobs';
  const adminToken = process.env['ADMIN_TOKEN'];
  const maxConcurrentRunsPerUser = parsePositiveIntEnv(process.env['MAX_CONCURRENT_RUNS'], 1);
  // Stays undefined when unset (no ceiling). A malformed value must NOT become
  // NaN — that would silently disable the ceiling (`used > NaN` is always
  // false) — so an invalid value is treated as "unset" with a warning. (M1)
  const rawMaxRunTokens = process.env['MAX_RUN_TOKENS'];
  let maxRunTokens: number | undefined;
  if (rawMaxRunTokens !== undefined && rawMaxRunTokens.trim() !== '') {
    const n = Number(rawMaxRunTokens);
    if (Number.isFinite(n) && n > 0) {
      maxRunTokens = Math.floor(n);
    } else {
      console.warn(
        `[playforge-api] ignoring invalid MAX_RUN_TOKENS ${JSON.stringify(rawMaxRunTokens)}; no run token ceiling`,
      );
    }
  }
  // Public app base URL for the exported game's "Remix this" CTA (#3.2). Configurable.
  const appBaseUrl = process.env['APP_BASE_URL'];

  // Phase 6.1 — credit purchase. Flag/env-gated: enabled by default in dev with
  // the MockCreditProvider; set CREDIT_PURCHASE_ENABLED=false to disable, or swap
  // in a real (Stripe) provider here later. CREDIT_PROVIDER selects the impl.
  const creditPurchaseEnabled = process.env['CREDIT_PURCHASE_ENABLED'] !== 'false';
  const creditProvider: CreditPurchaseProvider | undefined =
    creditPurchaseEnabled && (process.env['CREDIT_PROVIDER'] ?? 'mock') === 'mock'
      ? new MockCreditProvider()
      : undefined;

  // Phase 6.2 — password-reset email. Console transport is the dev default
  // (logs the reset link); a real provider swaps in behind EmailPort later.
  const email: EmailPort | undefined =
    (process.env['EMAIL_TRANSPORT'] ?? 'console') === 'console'
      ? new ConsoleEmailTransport()
      : undefined;

  const db = createDb(databaseUrl);

  const bus: EventBus = redisUrl ? new RedisEventBus(redisUrl) : new InMemoryEventBus();
  const store = new SnapshotStore(new LocalFsBlobStore(blobDir));

  const projectRepo = new DrizzleProjectRepo(db);
  const runRepo = new DrizzleRunRepo(db);
  const chatRepo = new DrizzleChatRepo(db);
  const snapshotRepo = new DrizzleSnapshotRepo(db);
  const accountRepo = new DrizzleAccountRepo(db);
  const publishRepo = new DrizzlePublishRepo(db);
  const hubRepo = new DrizzleHubRepo(db);

  let queue: Queue | undefined;
  let browserQueue: BrowserJobQueue | undefined;
  if (redisUrl) {
    queue = new Queue('generate', { connection: parseRedisUrl(redisUrl) });
    browserQueue = new BrowserJobQueue(redisUrl);
    console.log('[playforge-api] BullMQ queue connected to Redis');
  } else {
    console.log('[playforge-api] no REDIS_URL — running generation in-process');
  }

  const enqueue: EnqueueFn = async ({
    runId,
    projectId,
    userId,
    prompt,
    parentManifestKey,
    maxTokens,
    continuation,
    isRemix,
    model,
    apiKey,
  }) => {
    if (queue) {
      try {
        await queue.add(
          'generate',
          {
            runId,
            projectId,
            userId,
            prompt,
            model: model ?? platformModel,
            ...(apiKey !== undefined ? { apiKey } : {}),
            ...(parentManifestKey !== undefined ? { parentManifestKey } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(continuation !== undefined ? { continuation } : {}),
            ...(isRemix === true ? { isRemix } : {}),
          },
          { jobId: runId },
        );
      } catch (err) {
        // The credit reservation is already committed by the time we enqueue, so
        // a transient Redis failure here would otherwise strand a *paid* run in
        // 'queued' until the 30-min reaper. Mark it failed and refund now, so the
        // user is charged nothing and isn't frozen. Idempotent via the partial
        // unique 'credit_ledger_refund_key'. (correctness C3)
        console.error(`[run:${runId}] enqueue to BullMQ failed:`, err);
        await runRepo.updateStatus(runId, 'failed').catch(() => {});
        await db
          .insert(schema.creditLedger)
          .values({ userId, delta: CREDITS_PER_RUN, reason: 'refund', runId })
          .onConflictDoNothing()
          .catch((refundErr: unknown) => {
            console.error(`[run:${runId}] credit refund after enqueue failure failed:`, refundErr);
          });
      }
      return;
    }

    // In-process fallback (dev without Redis).
    void enqueueRun(
      {
        runId,
        projectId,
        prompt,
        model: model ?? platformModel,
        apiKey: apiKey ?? platformApiKey,
        ...(parentManifestKey !== undefined ? { parentManifestKey } : {}),
        ...(isRemix === true ? { isRemix } : {}),
      },
      { bus, store },
    )
      .then(async (result) => {
        const manifestKey = result.snapshot.manifestKey;
        await Promise.all([
          runRepo.setSnapshot(runId, manifestKey),
          projectRepo.setCurrentManifestKey(projectId, manifestKey),
          chatRepo.add(projectId, 'artifact_delivered', {
            runId,
            previewUrl: `/v1/runs/${runId}/preview/`,
            engine: result.engine,
          }),
        ]).catch((err: unknown) => {
          console.error(`[run:${runId}] post-completion update failed:`, err);
        });
      })
      .catch(async (err: unknown) => {
        console.error(`[run:${runId}] generation failed:`, err);
        await runRepo.updateStatus(runId, 'failed').catch(() => {});
        // Refund the enqueue-time reservation so a failed run costs nothing. This
        // mirrors the worker.on('failed') refund for the no-Redis in-process path.
        // Idempotent via the partial unique 'credit_ledger_refund_key'.
        await db
          .insert(schema.creditLedger)
          .values({ userId, delta: CREDITS_PER_RUN, reason: 'refund', runId })
          .onConflictDoNothing()
          .catch((refundErr: unknown) => {
            console.error(`[run:${runId}] credit refund failed:`, refundErr);
          });
      });
  };

  // OpenAI embeddings for Hub semantic search — only wired when provider is OpenAI.
  const embedText =
    modelProvider === 'openai'
      ? async (text: string): Promise<number[]> => {
          const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${platformApiKey}`,
            },
            body: JSON.stringify({ input: text, model: 'text-embedding-3-small' }),
          });
          const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
          const embedding = json.data?.[0]?.embedding;
          if (!embedding) throw new Error('Embedding API returned no vector');
          return embedding;
        }
      : undefined;

  const server = buildServer({
    repo: projectRepo,
    auth: new SessionAuthenticator(db),
    bus,
    runRepo,
    chatRepo,
    publishRepo,
    hubRepo,
    enqueue,
    store,
    snapshotRepo,
    authDb: db,
    accountRepo,
    platformModel,
    apiKeyEncryptionSecret,
    ...(adminToken !== undefined ? { adminToken } : {}),
    maxConcurrentRunsPerUser,
    ...(embedText !== undefined ? { embedText } : {}),
    ...(browserQueue !== undefined ? { browserQueue } : {}),
    ...(maxRunTokens !== undefined ? { maxRunTokens } : {}),
    ...(queue !== undefined ? { generateQueue: queue } : {}),
    ...(appBaseUrl !== undefined ? { appBaseUrl } : {}),
    ...(corsOrigins !== undefined ? { allowedCorsOrigins: corsOrigins } : {}),
    ...(creditProvider !== undefined ? { creditProvider } : {}),
    ...(email !== undefined ? { email } : {}),
  });

  // ── Graceful shutdown (4.4) ─────────────────────────────────────────────────
  // On SIGTERM/SIGINT: stop accepting new connections (server.close drains any
  // in-flight requests), then release the Redis-backed handles — the shared
  // event-bus publisher/readers and the BullMQ generate queue — so the process
  // exits cleanly instead of hanging on open sockets. Mirrors the browser-worker
  // pattern. Idempotent against a double signal.
  // Last-resort safety net: a stray rejection on a fire-and-forget path must be
  // logged, not silently dropped (Node may also terminate the process on an
  // unhandled rejection in a future major). We log and keep serving. (C3)
  process.on('unhandledRejection', (reason) => {
    console.error(
      '[playforge-api] unhandledRejection:',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });

  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[playforge-api] ${sig} — draining…`);
      void (async () => {
        await server
          .close()
          .catch((err: unknown) => console.error('[playforge-api] server close failed:', err));
        await bus
          .close()
          .catch((err: unknown) => console.error('[playforge-api] bus close failed:', err));
        if (queue) {
          await queue
            .close()
            .catch((err: unknown) => console.error('[playforge-api] queue close failed:', err));
        }
        process.exit(0);
      })();
    });
  }

  try {
    const address = await server.listen({ port, host: '0.0.0.0' });
    console.log(`[playforge-api] listening on ${address}`);
  } catch (err) {
    console.error('[playforge-api] startup error:', err);
    process.exit(1);
  }
}

// Autostart unless under test (Vitest sets VITEST) or explicitly disabled, so
// importing this module for its exported helpers doesn't try to boot the server
// (which would throw on missing DATABASE_URL). Mirrors the worker entrypoint.
if (process.env['API_NO_AUTOSTART'] !== '1' && process.env['VITEST'] === undefined) {
  void main();
}
