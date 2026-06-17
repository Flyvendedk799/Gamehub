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
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Queue, Worker } from 'bullmq';
import { RedisEventBus } from '@playforge/bus';
import { createDb, schema } from '@playforge/db';
import type { AbortKind, ModelRef } from '@playforge/shared';
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

/**
 * abortKind tag for runs the stuck-run reaper hard-fails. The `runs.abort_kind`
 * column is a free-text column typed as AbortKind for the agent-classified
 * kinds; 'reaped' is a reaper-only marker that never comes out of
 * classifyAbortKind, so we tag it with a single localized cast here (rather
 * than widening the shared AbortKind union, which is out of this change's
 * scope). The metrics route counts rows WHERE abort_kind = 'reaped'.
 */
const REAPED_ABORT_KIND = 'reaped' as AbortKind;

/** How long a run may sit in queued/running before it's eligible for reaping.
 *  Default 30 min — comfortably above the SSE 25-min cap and any legit build,
 *  so a slow-but-alive run is never reaped. Tunable via env. */
const DEFAULT_REAP_STUCK_AFTER_MS = 30 * 60 * 1000;
/** How often the reaper sweep runs. */
const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;

/** A run row the reaper inspects. Minimal shape so the pure selector is trivial
 *  to unit-test without a live Postgres. */
export interface ReapCandidate {
  id: string;
  userId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'canceled';
  /** When the run was last touched (updatedAt), epoch ms. */
  lastTouchedMs: number;
}

export interface ReapDecisionOptions {
  /** Current wall-clock, epoch ms. */
  nowMs: number;
  /** A run is stale once (now - lastTouched) exceeds this. */
  stuckAfterMs: number;
}

/**
 * PURE — decide which runs are *candidates* for reaping based solely on status
 * + staleness. A candidate is a run that is still non-terminal (queued/running)
 * and has not been touched within the staleness window. The caller MUST still
 * cross-check the BullMQ job's real state (job gone / failed) before reaping +
 * refunding, because a slow-but-alive job updates `updatedAt` on completion,
 * not continuously — so staleness alone is necessary, not sufficient.
 *
 * Extracted as a free function so the "which runs to reap" decision is unit
 * testable in isolation: a run past the threshold is selected; a healthy/recent
 * run, or one already in a terminal state, is not.
 */
export function selectRunsToReap(
  runs: readonly ReapCandidate[],
  opts: ReapDecisionOptions,
): ReapCandidate[] {
  return runs.filter(
    (r) =>
      (r.status === 'queued' || r.status === 'running') &&
      opts.nowMs - r.lastTouchedMs > opts.stuckAfterMs,
  );
}

/**
 * PURE — given a stale candidate and the live BullMQ job state, decide whether
 * to actually reap it. We reap only when the job is genuinely gone or failed
 * (i.e. no worker will ever finish it). A job that is still 'active', 'waiting',
 * or 'delayed' is alive — staleness is a false positive (a long-running active
 * job, or one queued behind a backlog) and we leave it alone.
 *
 * `jobState` is null when getJob() found no job at all (job gone → reap).
 */
/** BullMQ JobState plus 'unknown', and null when no job exists at all. */
export type ReapJobState =
  | 'completed'
  | 'failed'
  | 'active'
  | 'waiting'
  | 'delayed'
  | 'paused'
  | 'prioritized'
  | 'waiting-children'
  | 'unknown'
  | null;

export function shouldReapStaleRun(jobState: ReapJobState): boolean {
  if (jobState === null) return true; // job no longer exists → orphaned run
  if (jobState === 'failed') return true; // job failed but run never transitioned
  if (jobState === 'completed') return true; // job done but run never transitioned
  // active / waiting / delayed / paused / prioritized → still alive, don't reap.
  return false;
}

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

  // ── Stuck-run reaper (4.1) ────────────────────────────────────────────────
  // A run can strand in 'queued'/'running' if a worker process dies mid-job
  // before the 'failed' handler fires, or the BullMQ job is otherwise lost. Such
  // a run holds a credit reservation forever and shows as perpetually "active".
  //
  // The reaper periodically sweeps non-terminal runs that haven't been touched
  // within the staleness window, cross-checks each one's REAL BullMQ job state
  // (gone / failed / completed ⇒ no worker will finish it), then marks the run
  // 'failed' (abortKind 'reaped') and REFUNDS the reservation EXACTLY ONCE via
  // the same idempotent pattern as worker.on('failed') / the cancel route
  // (insert +CREDITS_PER_RUN, reason 'refund', runId, onConflictDoNothing —
  // guarded by the partial-unique 'credit_ledger_refund_key').
  const reapQueue = new Queue('generate', { connection });
  const stuckAfterMs = Number(process.env['REAP_STUCK_AFTER_MS'] ?? String(DEFAULT_REAP_STUCK_AFTER_MS));
  const reapIntervalMs = Number(process.env['REAP_INTERVAL_MS'] ?? String(DEFAULT_REAP_INTERVAL_MS));

  async function reapStuckRunsOnce(): Promise<number> {
    // Pull non-terminal runs; the pure selector decides which are stale.
    const rows = await db
      .select({
        id: schema.runs.id,
        userId: schema.runs.userId,
        status: schema.runs.status,
        updatedAt: schema.runs.updatedAt,
      })
      .from(schema.runs)
      .where(inArray(schema.runs.status, ['queued', 'running']));

    const candidates = selectRunsToReap(
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        status: r.status,
        lastTouchedMs: r.updatedAt.getTime(),
      })),
      { nowMs: Date.now(), stuckAfterMs },
    );

    let reaped = 0;
    for (const candidate of candidates) {
      // Cross-check the REAL job state before reaping — staleness alone is not
      // sufficient (a long-but-alive active job hasn't bumped updatedAt yet).
      let jobState: ReapJobState = null;
      try {
        const job = await reapQueue.getJob(candidate.id);
        jobState = job ? ((await job.getState()) as ReapJobState) : null;
      } catch (err) {
        console.error(`[reaper] could not read job state for run ${candidate.id}:`, err);
        continue; // be conservative — skip rather than reap a possibly-live run
      }
      if (!shouldReapStaleRun(jobState)) continue;

      // Mark failed. Guard the UPDATE on the still-non-terminal status so we
      // never clobber a run that completed in the race between SELECT and here;
      // .returning() tells us whether THIS sweep actually transitioned the run.
      // If 0 rows changed (a concurrent completion/cancel won the race), we must
      // NOT refund — a completed run legitimately keeps its reservation.
      let transitioned = false;
      try {
        const updated = await db
          .update(schema.runs)
          .set({ status: 'failed', abortKind: REAPED_ABORT_KIND, updatedAt: new Date(), finishedAt: new Date() })
          .where(and(eq(schema.runs.id, candidate.id), inArray(schema.runs.status, ['queued', 'running'])))
          .returning({ id: schema.runs.id });
        transitioned = updated.length > 0;
      } catch (err) {
        console.error(`[reaper] failed to mark run ${candidate.id} failed:`, err);
        continue;
      }
      if (!transitioned) continue;

      // Refund EXACTLY ONCE — idempotent via 'credit_ledger_refund_key'.
      await db
        .insert(schema.creditLedger)
        .values({ userId: candidate.userId, delta: CREDITS_PER_RUN, reason: 'refund', runId: candidate.id })
        .onConflictDoNothing()
        .catch((refundErr: unknown) => {
          console.error(`[reaper] credit refund failed for run ${candidate.id}:`, refundErr);
        });

      reaped += 1;
      console.warn(`[reaper] reaped stuck run ${candidate.id} (state=${jobState ?? 'gone'})`);
    }
    return reaped;
  }

  const reaperTimer = setInterval(() => {
    void reapStuckRunsOnce().catch((err: unknown) => {
      console.error('[reaper] sweep failed:', err);
    });
  }, reapIntervalMs);
  // Don't keep the event loop alive solely for the reaper.
  reaperTimer.unref();

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

  // ── Graceful shutdown (4.4) ───────────────────────────────────────────────
  // Mirror the proven browser-worker pattern: on SIGTERM/SIGINT, stop the
  // reaper, let the BullMQ Worker finish/release its active job, then close
  // every Redis-backed handle (worker, reaper queue, browser-jobs client, bus)
  // so the process exits instead of hanging on open connections.
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[playforge-worker] ${sig} — draining…`);
      void (async () => {
        clearInterval(reaperTimer);
        // worker.close() waits for the in-flight job to finish, then stops
        // pulling new jobs and releases its Redis connection.
        await worker.close().catch((err: unknown) => console.error('[worker] close failed:', err));
        await reapQueue.close().catch((err: unknown) => console.error('[reaper] queue close failed:', err));
        await browserClient?.close().catch((err: unknown) => console.error('[browser-jobs] close failed:', err));
        await bus.close().catch((err: unknown) => console.error('[bus] close failed:', err));
        process.exit(0);
      })();
    });
  }

  console.log(`[playforge-worker] listening for generate jobs (concurrency=${concurrency})`);
}

// Only auto-start when run as the entrypoint, not when a test imports the pure
// selectRunsToReap / shouldReapStaleRun helpers (importing must not boot Redis
// or require DATABASE_URL). Vitest sets VITEST=true; WORKER_NO_AUTOSTART=1 is
// the explicit escape hatch for any other importer.
if (process.env['WORKER_NO_AUTOSTART'] !== '1' && process.env['VITEST'] === undefined) {
  void main();
}
