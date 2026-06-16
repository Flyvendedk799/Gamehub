/**
 * Generation worker — BullMQ consumer.
 *
 * Processes `generate` jobs enqueued by the API. Each job runs the full
 * agent pipeline (runGeneration) and writes completion state to Postgres.
 * Events are published to Redis Streams via RedisEventBus so the API's SSE
 * relay can stream them to any browser, on any API instance.
 *
 * Continuation / resume:
 *   When the agent pauses at a safe boundary (output.interrupted), the job
 *   saves the ContinuationPromptInput to runs.continuation and marks the run
 *   as 'paused' rather than 'completed'. The API re-enqueues with the stored
 *   continuation on the next user prompt, and queue.ts calls
 *   buildContinuationPrompt() to reconstruct the resume prompt.
 *
 * Required env vars:
 *   DATABASE_URL        Postgres connection string
 *   PLATFORM_API_KEY    LLM API key (used when job doesn't carry apiKey)
 *   REDIS_URL           Redis connection string (default: redis://127.0.0.1:6379)
 *
 * Optional:
 *   PLATFORM_MODEL_ID   e.g. o4-mini (default)
 *   PLATFORM_PROVIDER   e.g. openai (default)
 *   BLOB_DIR            local blob-store root (default: .playforge-blobs)
 *   WORKER_CONCURRENCY  parallel jobs per instance (default: 2)
 */
import { eq, sql } from 'drizzle-orm';
import { Worker } from 'bullmq';
import { RedisEventBus } from '@playforge/bus';
import { createDb, schema } from '@playforge/db';
import type { ModelRef } from '@playforge/shared';
import { classifyAbortKind } from '@playforge/shared';
import { LocalFsBlobStore, SnapshotStore } from '@playforge/storage';
import type { ContinuationPromptInput } from '@playforge/agent-core';
import { enqueueRun } from './queue';

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

const CREDITS_PER_RUN = 10;

interface GenerateJobData {
  runId: string;
  projectId: string;
  userId: string;
  prompt: string;
  parentManifestKey?: string;
  /** BYOK: per-job API key override. */
  apiKey?: string;
  model?: ModelRef;
  /** Resume a previously paused run — replaces prompt with buildContinuationPrompt. */
  continuation?: ContinuationPromptInput;
  /** Hard token ceiling (input + output). Worker aborts the run if exceeded. */
  maxTokens?: number;
  /**
   * When true, the working tree is seeded from a remixed project. queue.ts will
   * prepend the untrusted-content safety header to the effective prompt.
   */
  isRemix?: boolean;
}

async function main() {
  const databaseUrl = requireEnv('DATABASE_URL');
  const platformApiKey = requireEnv('PLATFORM_API_KEY');
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const modelId = process.env['PLATFORM_MODEL_ID'] ?? 'o4-mini';
  const modelProvider = process.env['PLATFORM_PROVIDER'] ?? 'openai';
  const blobDir = process.env['BLOB_DIR'] ?? '.playforge-blobs';
  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? '2');

  const db = createDb(databaseUrl);
  const bus = new RedisEventBus(redisUrl);
  const store = new SnapshotStore(new LocalFsBlobStore(blobDir));
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<GenerateJobData>(
    'generate',
    async (job) => {
      const { runId, projectId, prompt, parentManifestKey, apiKey: jobApiKey, model: jobModel, continuation, maxTokens, isRemix } = job.data;
      const apiKey = jobApiKey ?? platformApiKey;
      const model: ModelRef = jobModel ?? { provider: modelProvider, modelId };

      console.log(`[worker] starting job ${job.id} run=${runId}${continuation ? ' (resume)' : ''}`);

      await db
        .update(schema.runs)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(schema.runs.id, runId));

      const result = await enqueueRun(
        {
          runId,
          projectId,
          prompt,
          model,
          apiKey,
          ...(parentManifestKey !== undefined ? { parentManifestKey } : {}),
          ...(continuation !== undefined ? { continuation } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(isRemix === true ? { isRemix } : {}),
        },
        { bus, store },
      );

      const manifestKey = result.snapshot.manifestKey;

      // Compute next chat seq atomically enough for single-worker concurrency.
      const [seqRow] = await db
        .select({ val: sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), -1)` })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.projectId, projectId));
      const nextSeq = (seqRow?.val ?? -1) + 1;

      if (result.pausedContinuation) {
        // Agent paused at a safe boundary. Persist continuation state + chat row.
        await Promise.all([
          db
            .update(schema.runs)
            .set({
              snapshotManifestKey: manifestKey,
              status: 'paused',
              continuation: result.pausedContinuation as unknown,
              updatedAt: new Date(),
            })
            .where(eq(schema.runs.id, runId)),
          db
            .update(schema.projects)
            .set({ currentManifestKey: manifestKey, updatedAt: new Date() })
            .where(eq(schema.projects.id, projectId)),
          db.insert(schema.chatMessages).values({
            projectId,
            seq: nextSeq,
            kind: 'continuation_pending',
            payload: { runId, manifestKey },
          }),
        ]);
        console.log(`[worker] paused job ${job.id} run=${runId} manifest=${manifestKey}`);
        return { manifestKey, paused: true };
      }

      // Compute next snapshot seq for this project.
      const [snapSeqRow] = await db
        .select({ val: sql<number>`COALESCE(MAX(${schema.snapshots.seq}), -1)` })
        .from(schema.snapshots)
        .where(eq(schema.snapshots.projectId, projectId));
      const nextSnapSeq = (snapSeqRow?.val ?? -1) + 1;

      // Fetch parent snapshot id (for the DAG chain).
      const [projectRow] = await db
        .select({ currentSnapshotId: schema.projects.currentSnapshotId })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId));
      const parentSnapshotId = projectRow?.currentSnapshotId ?? null;

      // Insert immutable snapshot row.
      const [snapshotRow] = await db
        .insert(schema.snapshots)
        .values({
          projectId,
          ...(parentSnapshotId !== null ? { parentId: parentSnapshotId } : {}),
          seq: nextSnapSeq,
          type: nextSnapSeq === 0 ? 'initial' : 'edit',
          prompt,
          ...(result.spec !== null ? { gameSpec: result.spec } : {}),
          ...(result.engine !== null ? { engine: result.engine } : {}),
          filesManifestKey: manifestKey,
          filesHash: result.snapshot.filesHash,
        })
        .returning({ id: schema.snapshots.id });

      const snapshotId = snapshotRow?.id ?? null;

      await Promise.all([
        db
          .update(schema.runs)
          .set({
            snapshotManifestKey: manifestKey,
            status: 'completed',
            updatedAt: new Date(),
            finishedAt: new Date(),
          })
          .where(eq(schema.runs.id, runId)),
        db
          .update(schema.projects)
          .set({
            currentManifestKey: manifestKey,
            updatedAt: new Date(),
            ...(snapshotId !== null ? { currentSnapshotId: snapshotId } : {}),
          })
          .where(eq(schema.projects.id, projectId)),
        db.insert(schema.chatMessages).values({
          projectId,
          seq: nextSeq,
          kind: 'artifact_delivered',
          payload: {
            runId,
            previewUrl: `/v1/runs/${runId}/preview/`,
            engine: result.engine,
            snapshotId,
          },
        }),
      ]);

      // Deduct generation credits from the user's ledger.
      await db.insert(schema.creditLedger).values({
        userId: job.data.userId,
        delta: -CREDITS_PER_RUN,
        reason: 'generation',
        runId,
      }).catch((err: unknown) => {
        console.error(`[worker] credit deduction failed for run ${runId}:`, err);
      });

      console.log(`[worker] completed job ${job.id} run=${runId} manifest=${manifestKey}`);
      return { manifestKey };
    },
    { connection, concurrency },
  );

  worker.on('failed', async (job, err) => {
    const runId = job?.data.runId;
    const abortKind = classifyAbortKind(err instanceof Error ? err.message : String(err));
    console.error(`[worker] job ${job?.id ?? '?'} run=${runId ?? '?'} failed (${abortKind}):`, err);
    if (runId) {
      await db
        .update(schema.runs)
        .set({ status: 'failed', abortKind, updatedAt: new Date() })
        .where(eq(schema.runs.id, runId))
        .catch(() => {});
    }
  });

  console.log(`[playforge-worker] listening for generate jobs (concurrency=${concurrency})`);
}

void main();
