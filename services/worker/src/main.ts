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
import {
  BrowserJobsClient,
  type PlaytestResult,
  type PlaytestStep,
  type RuntimeVerifyResult,
} from './browser-jobs';
import { enqueueRun } from './queue';
import type { BrowserJobsPort } from './run-generation';

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

  // #1.4 — out-of-process browser-jobs port. The gen worker NEVER boots
  // untrusted game code in-process; it round-trips runtime-verify + playtest
  // requests to the dedicated browser-worker pool over the `browser-jobs`
  // BullMQ queue (same REDIS_URL). This makes the agent's `done` runtime-load
  // gate and `playtest_game` tool live in production, replacing the previous
  // static-lint-only force-accept. Set DISABLE_BROWSER_JOBS=1 to fall back to
  // the no-verification behaviour (e.g. when no browser-worker is deployed).
  const browserClient =
    process.env['DISABLE_BROWSER_JOBS'] === '1' ? undefined : new BrowserJobsClient(redisUrl);
  const browserJobs: BrowserJobsPort | undefined =
    browserClient === undefined
      ? undefined
      : {
          async runtimeVerify(htmlContent: string) {
            const jobId = await browserClient.enqueueRuntimeVerify(htmlContent);
            const result = await browserClient.waitForResult<RuntimeVerifyResult>(jobId, 20_000);
            if (result === null) return null;
            return { hasGameContract: result.hasGameContract, fatalErrors: result.fatalErrors };
          },
          async playtest(htmlContent: string, steps: ReadonlyArray<PlaytestStep>) {
            const jobId = await browserClient.enqueuePlaytest(htmlContent, [...steps]);
            const result = await browserClient.waitForResult<PlaytestResult>(jobId, 30_000);
            if (result === null) return null;
            return {
              hasGameContract: result.hasGameContract,
              hasDebugContract: result.hasDebugContract,
              baselineSnapshot: result.baselineSnapshot,
              steps: result.steps,
              bootErrors: result.bootErrors,
            };
          },
        };

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
        { bus, store, ...(browserJobs !== undefined ? { browserJobs } : {}) },
      );

      const manifestKey = result.snapshot.manifestKey;

      if (result.pausedContinuation) {
        // Compute next chat seq atomically enough for single-worker concurrency.
        const [seqRow] = await db
          .select({ val: sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), -1)` })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.projectId, projectId));
        const nextSeq = (seqRow?.val ?? -1) + 1;

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

        // A paused run is non-terminal: it is superseded by a fresh resume run
        // (new runId) that reserves its own cost at enqueue. Refund THIS run's
        // enqueue-time reservation so a pause→resume cycle costs CREDITS_PER_RUN
        // exactly once (restoring the pre-reservation "paused runs cost 0"
        // semantics), not twice. Idempotent via the 'credit_ledger_refund_key'
        // partial unique, exactly like the worker.on('failed') refund.
        const pausedUserId = job.data.userId;
        if (pausedUserId) {
          await db
            .insert(schema.creditLedger)
            .values({ userId: pausedUserId, delta: CREDITS_PER_RUN, reason: 'refund', runId })
            .onConflictDoNothing()
            .catch((refundErr: unknown) => {
              console.error(`[worker] paused-run refund failed for run ${runId}:`, refundErr);
            });
        }

        console.log(`[worker] paused job ${job.id} run=${runId} manifest=${manifestKey}`);
        return { manifestKey, paused: true };
      }

      // ── Transactional completion write (#9) ────────────────────────────────
      // All post-agent state lands in ONE transaction so a partial failure can't
      // strand a finished run: either the snapshot row, run→completed, project
      // HEAD advance, and chat row all commit, or none do (and the run stays
      // non-terminal for the worker.on('failed') refund/retry path to handle).
      //
      // Idempotency: a BullMQ retry of an ALREADY-completed run must not insert a
      // duplicate snapshot. We SELECT … FOR UPDATE the run row first; if it is
      // already 'completed', we short-circuit. Snapshot-seq is allocated under a
      // FOR UPDATE lock on the project row, and we retry once on the off chance a
      // concurrent writer wins the (project_id, seq) UNIQUE race.
      const completedManifestKey = await db.transaction(async (tx) => {
        // Lock the run row; short-circuit a retry of an already-completed run.
        const [runRow] = await tx
          .select({ status: schema.runs.status, existingManifest: schema.runs.snapshotManifestKey })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId))
          .for('update');
        if (runRow?.status === 'completed') {
          console.log(`[worker] run=${runId} already completed — skipping duplicate write`);
          return runRow.existingManifest ?? manifestKey;
        }

        // Lock the project row so snapshot-seq allocation + HEAD advance are
        // serialized against any concurrent run on the same project.
        const [projectRow] = await tx
          .select({ currentSnapshotId: schema.projects.currentSnapshotId })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .for('update');
        const parentSnapshotId = projectRow?.currentSnapshotId ?? null;

        // Allocate the next snapshot seq under the project-row lock; the UNIQUE
        // (project_id, seq) is the real guard. Retry once on a unique violation.
        let snapshotId: string | null = null;
        for (let attempt = 0; attempt < 2 && snapshotId === null; attempt++) {
          const [snapSeqRow] = await tx
            .select({ val: sql<number>`COALESCE(MAX(${schema.snapshots.seq}), -1)` })
            .from(schema.snapshots)
            .where(eq(schema.snapshots.projectId, projectId));
          const nextSnapSeq = (snapSeqRow?.val ?? -1) + 1 + attempt;
          try {
            const [snapshotRow] = await tx
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
            snapshotId = snapshotRow?.id ?? null;
          } catch (insErr) {
            if (attempt === 1) throw insErr; // give up after one retry
          }
        }

        // Next chat seq, allocated inside the txn for consistency with the writes.
        const [chatSeqRow] = await tx
          .select({ val: sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), -1)` })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.projectId, projectId));
        const nextChatSeq = (chatSeqRow?.val ?? -1) + 1;

        await tx
          .update(schema.runs)
          .set({
            snapshotManifestKey: manifestKey,
            status: 'completed',
            updatedAt: new Date(),
            finishedAt: new Date(),
          })
          .where(eq(schema.runs.id, runId));
        await tx
          .update(schema.projects)
          .set({
            currentManifestKey: manifestKey,
            updatedAt: new Date(),
            ...(snapshotId !== null ? { currentSnapshotId: snapshotId } : {}),
            ...(result.engine !== null ? { engine: result.engine } : {}),
          })
          .where(eq(schema.projects.id, projectId));
        await tx.insert(schema.chatMessages).values({
          projectId,
          seq: nextChatSeq,
          kind: 'artifact_delivered',
          payload: {
            runId,
            previewUrl: `/v1/runs/${runId}/preview/`,
            engine: result.engine,
            snapshotId,
          },
        });

        return manifestKey;
      });

      // NOTE: No credit debit here. The run cost was already RESERVED at enqueue
      // (negative 'reservation' ledger row, keyed on runId by the API). A
      // successful run keeps that reservation — net cost -CREDITS_PER_RUN — so
      // debiting again would double-charge. The 'failed' handler below refunds
      // the reservation when a run does not complete.

      console.log(`[worker] completed job ${job.id} run=${runId} manifest=${completedManifestKey}`);
      return { manifestKey: completedManifestKey };
    },
    { connection, concurrency },
  );

  worker.on('failed', async (job, err) => {
    const runId = job?.data.runId;
    const userId = job?.data.userId;
    const abortKind = classifyAbortKind(err instanceof Error ? err.message : String(err));
    console.error(`[worker] job ${job?.id ?? '?'} run=${runId ?? '?'} failed (${abortKind}):`, err);
    if (runId) {
      await db
        .update(schema.runs)
        .set({ status: 'failed', abortKind, updatedAt: new Date() })
        .where(eq(schema.runs.id, runId))
        .catch(() => {});

      // Refund the enqueue-time reservation so a failed run costs nothing. The
      // partial unique 'credit_ledger_refund_key' (run_id WHERE reason='refund')
      // makes this idempotent: a BullMQ retry that ultimately fails, or both this
      // handler and the in-process .catch firing, refunds exactly once.
      if (userId) {
        await db
          .insert(schema.creditLedger)
          .values({ userId, delta: CREDITS_PER_RUN, reason: 'refund', runId })
          .onConflictDoNothing()
          .catch((refundErr: unknown) => {
            console.error(`[worker] credit refund failed for run ${runId}:`, refundErr);
          });
      }
    }
  });

  console.log(`[playforge-worker] listening for generate jobs (concurrency=${concurrency})`);
}

void main();
