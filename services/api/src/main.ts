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
 *   PORT                HTTP listen port (default 3100)
 *   BLOB_DIR            local blob-store root (default: .playforge-blobs)
 */
import { Queue } from 'bullmq';
import { createDb } from '@playforge/db';
import { InMemoryEventBus, RedisEventBus, type EventBus } from '@playforge/bus';
import { LocalFsBlobStore, SnapshotStore } from '@playforge/storage';
import { enqueueRun } from '../../worker/src/queue';
import { HeaderAuthenticator } from './auth';
import { DrizzleChatRepo, DrizzleProjectRepo, DrizzleRunRepo } from './drizzle-repos';
import { DrizzleHubRepo } from './hub-repo';
import { DrizzlePublishRepo } from './publish-repo';
import { buildServer, type EnqueueFn } from './server';

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

async function main() {
  const databaseUrl = requireEnv('DATABASE_URL');
  const apiKey = requireEnv('PLATFORM_API_KEY');
  const modelId = process.env['PLATFORM_MODEL_ID'] ?? 'o4-mini';
  const modelProvider = process.env['PLATFORM_PROVIDER'] ?? 'openai';
  const port = Number(process.env['PORT'] ?? '3100');
  const redisUrl = process.env['REDIS_URL'];
  const blobDir = process.env['BLOB_DIR'] ?? '.playforge-blobs';
  const adminToken = process.env['ADMIN_TOKEN'];
  const maxConcurrentRunsPerUser = Number(process.env['MAX_CONCURRENT_RUNS'] ?? '1');

  const db = createDb(databaseUrl);

  const bus: EventBus = redisUrl ? new RedisEventBus(redisUrl) : new InMemoryEventBus();
  const store = new SnapshotStore(new LocalFsBlobStore(blobDir));

  const projectRepo = new DrizzleProjectRepo(db);
  const runRepo = new DrizzleRunRepo(db);
  const chatRepo = new DrizzleChatRepo(db);
  const publishRepo = new DrizzlePublishRepo(db);
  const hubRepo = new DrizzleHubRepo(db);

  let queue: Queue | undefined;
  if (redisUrl) {
    queue = new Queue('generate', { connection: parseRedisUrl(redisUrl) });
    console.log('[playforge-api] BullMQ queue connected to Redis');
  } else {
    console.log('[playforge-api] no REDIS_URL — running generation in-process');
  }

  const enqueue: EnqueueFn = async ({ runId, projectId, userId, prompt, parentManifestKey }) => {
    if (queue) {
      await queue.add(
        'generate',
        {
          runId,
          projectId,
          userId,
          prompt,
          model: { provider: modelProvider, modelId },
          ...(parentManifestKey !== undefined ? { parentManifestKey } : {}),
        },
        { jobId: runId },
      );
      return;
    }

    // In-process fallback (dev without Redis).
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
  };

  const server = buildServer({
    repo: projectRepo,
    auth: new HeaderAuthenticator(),
    bus,
    runRepo,
    chatRepo,
    publishRepo,
    hubRepo,
    enqueue,
    store,
    ...(adminToken !== undefined ? { adminToken } : {}),
    maxConcurrentRunsPerUser,
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
