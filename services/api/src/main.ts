/**
 * Live API entry point — wires real infrastructure for Phase 0.
 *
 * Phase 0 strategy: generation runs in-process (the EnqueueFn calls
 * enqueueRun directly, no BullMQ) and events flow through InMemoryEventBus
 * (no Redis). This proves the full path — POST generate → SSE stream → PG
 * snapshot — without requiring a queue. BullMQ + RedisEventBus swap in at
 * Phase 1 with zero changes to routes or worker logic.
 *
 * Required env vars:
 *   DATABASE_URL        Postgres connection string (postgres://...)
 *   PLATFORM_API_KEY    Anthropic/OpenAI key for the platform account
 *   PLATFORM_MODEL_ID   e.g. claude-opus-4-8
 *   PLATFORM_PROVIDER   e.g. anthropic (default)
 *
 * Optional:
 *   PORT                HTTP listen port (default 3100)
 *   DEV_USER_ID         UUID of a pre-seeded dev user in the DB (for x-user-id
 *                       testing without Clerk). Leave unset in production.
 */
import { createDb } from '@playforge/db';
import { InMemoryEventBus } from '@playforge/bus';
import { LocalFsBlobStore, SnapshotStore } from '@playforge/storage';
import { enqueueRun } from '../../worker/src/queue';
import { HeaderAuthenticator } from './auth';
import { DrizzleChatRepo, DrizzleProjectRepo, DrizzleRunRepo } from './drizzle-repos';
import { buildServer, type EnqueueFn } from './server';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

async function main() {
  const databaseUrl = requireEnv('DATABASE_URL');
  const apiKey = requireEnv('PLATFORM_API_KEY');
  const modelId = process.env['PLATFORM_MODEL_ID'] ?? 'claude-opus-4-8';
  const modelProvider = process.env['PLATFORM_PROVIDER'] ?? 'anthropic';
  const port = Number(process.env['PORT'] ?? '3100');

  const db = createDb(databaseUrl);
  const bus = new InMemoryEventBus();

  // Object storage: local filesystem under .playforge-blobs/ for Phase 0.
  // Swap for S3BlobStore / R2BlobStore when cloud storage is wired.
  const blobDir = process.env['BLOB_DIR'] ?? '.playforge-blobs';
  const store = new SnapshotStore(new LocalFsBlobStore(blobDir));

  const projectRepo = new DrizzleProjectRepo(db);
  const runRepo = new DrizzleRunRepo(db);
  const chatRepo = new DrizzleChatRepo(db);

  const enqueue: EnqueueFn = async ({ runId, projectId, userId, prompt, parentManifestKey }) => {
    // Fire-and-forget: the worker publishes events to bus as it runs.
    void enqueueRun(
      {
        runId,
        projectId,
        prompt,
        model: { provider: modelProvider, modelId },
        apiKey,
        ...(parentManifestKey !== undefined ? { parentManifestKey } : {}),
      },
      { bus, store },
    ).then(async (result) => {
      const manifestKey = result.snapshot.manifestKey;
      // Persist snapshot key + update project's HEAD manifest in parallel.
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
    }).catch(async (err: unknown) => {
      console.error(`[run:${runId}] generation failed:`, err);
      await runRepo.updateStatus(runId, 'failed').catch(() => {});
    });
    // Return immediately — the caller streams events via SSE.
  };

  const server = buildServer({
    repo: projectRepo,
    auth: new HeaderAuthenticator(),
    bus,
    runRepo,
    chatRepo,
    enqueue,
    store,
  });

  try {
    const address = await server.listen({ port, host: '0.0.0.0' });
    console.log(`[playforge-api] listening on ${address}`);
  } catch (err) {
    console.error('[playforge-api] startup error:', err);
    process.exit(1);
  }
}

void main();
