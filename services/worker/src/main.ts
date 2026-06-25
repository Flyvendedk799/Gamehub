import { performance } from 'node:perf_hooks';
import type { ContinuationPromptInput } from '@playforge/agent-core';
import { RedisEventBus } from '@playforge/bus';
import { createDb, schema } from '@playforge/db';
import type { AbortKind, GameSpec, ModelRef } from '@playforge/shared';
import { classifyAbortKind } from '@playforge/shared';
import { LocalFsBlobStore, SnapshotStore } from '@playforge/storage';
import { Queue, Worker } from 'bullmq';
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
import { and, eq, inArray } from 'drizzle-orm';
import {
  BrowserJobsClient,
  type PlaytestResult,
  type PlaytestStep,
  type RuntimeVerifyResult,
} from './browser-jobs';
import { finalizeRun } from './finalize-run';
import { enqueueRun } from './queue';
import type { BrowserJobsPort, WebEngine } from './run-generation';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/**
 * Parse a positive-integer env var, falling back to `fallback` for unset OR
 * malformed values. Guards against a typo like `WORKER_CONCURRENCY=two` →
 * `NaN`, which silently breaks downstream consumers: `new Worker({concurrency:
 * NaN})`, `setInterval(fn, NaN)` (NaN coerces to a 0ms hot loop), and a `NaN`
 * token ceiling makes every `used > NaN` comparison false, disabling the budget. (M1)
 */
export function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[playforge-worker] ignoring invalid numeric env value ${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(n);
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
  /** The project's chosen engine (iteration) — agent skips choose_engine. */
  engine?: WebEngine;
  /** Prior snapshot's game spec (iteration) — agent amends instead of re-declaring. */
  gameSpec?: GameSpec;
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
  const concurrency = parsePositiveIntEnv(process.env['WORKER_CONCURRENCY'], 2);

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
            return {
              hasGameContract: result.hasGameContract,
              fatalErrors: result.fatalErrors,
              ...(result.juiceScore !== undefined ? { juiceScore: result.juiceScore } : {}),
              ...(result.renderedNonBlank !== undefined
                ? { renderedNonBlank: result.renderedNonBlank }
                : {}),
            };
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
      const {
        runId,
        projectId,
        prompt,
        parentManifestKey,
        engine,
        gameSpec,
        apiKey: jobApiKey,
        model: jobModel,
        continuation,
        maxTokens,
        isRemix,
      } = job.data;
      const apiKey = jobApiKey ?? platformApiKey;
      const model: ModelRef = jobModel ?? { provider: modelProvider, modelId };

      console.log(`[worker] starting job ${job.id} run=${runId}${continuation ? ' (resume)' : ''}`);

      await db
        .update(schema.runs)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(schema.runs.id, runId));

      // Bracket the active agent loop for the social-outro "AI runtime" metric
      // (docs/SOCIAL_OUTRO_PLAN.md): wall-clock start + a monotonic start, and a
      // finally that persists the elapsed ms — excludes queue wait / idle time.
      const aiStartedAt = new Date();
      const aiStartMs = performance.now();
      let result: Awaited<ReturnType<typeof enqueueRun>>;
      try {
        result = await enqueueRun(
          {
            runId,
            projectId,
            prompt,
            model,
            apiKey,
            ...(parentManifestKey !== undefined ? { parentManifestKey } : {}),
            ...(engine !== undefined ? { engine } : {}),
            ...(gameSpec !== undefined ? { gameSpec } : {}),
            ...(continuation !== undefined ? { continuation } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(isRemix === true ? { isRemix } : {}),
          },
          {
            bus,
            store,
            ...(browserJobs !== undefined ? { browserJobs } : {}),
            // #5.6 — persist the per-run quality telemetry row. numeric(juice_score)
            // is string-typed in drizzle, so the measured score is stringified.
            // onConflictDoUpdate so a resumed run's final ship overwrites the row.
            recordRunQuality: async (qRunId, m) => {
              const juiceScore = m.juiceScore === null ? null : String(m.juiceScore);
              const row = {
                runId: qRunId,
                genre: m.genre,
                forceAccept: m.forceAccept,
                repairRounds: m.repairRounds,
                shipReason: m.shipReason,
                playbookPass: m.playbookPass,
                playbookTotal: m.playbookTotal,
                juiceScore,
                runtimeBooted: m.runtimeBooted,
                report: m.report ?? null,
              };
              await db
                .insert(schema.runQualityMetrics)
                .values(row)
                .onConflictDoUpdate({
                  target: schema.runQualityMetrics.runId,
                  set: {
                    genre: row.genre,
                    forceAccept: row.forceAccept,
                    repairRounds: row.repairRounds,
                    shipReason: row.shipReason,
                    playbookPass: row.playbookPass,
                    playbookTotal: row.playbookTotal,
                    juiceScore: row.juiceScore,
                    runtimeBooted: row.runtimeBooted,
                    report: row.report,
                  },
                });
            },
            // Durable build-feed log so the SSE relay can replay after a refresh.
            persistEvent: async (rec) => {
              await db
                .insert(schema.runEvents)
                .values({
                  runId: rec.runId,
                  projectId: rec.projectId,
                  seq: rec.seq,
                  event: rec.event,
                })
                .onConflictDoNothing();
            },
          },
        );
      } finally {
        // Persist the active-generation runtime regardless of success/throw.
        // The worker.on('failed') handler still marks the run failed; this only
        // records timing on the row. Don't let a timing write mask the real error.
        const aiFinishedAt = new Date();
        const aiRuntimeMs = Math.max(0, Math.round(performance.now() - aiStartMs));
        await db
          .update(schema.runs)
          .set({ aiStartedAt, aiFinishedAt, aiRuntimeMs, updatedAt: new Date() })
          .where(eq(schema.runs.id, runId))
          .catch((err: unknown) =>
            console.error(`[worker] run=${runId} ai-runtime persist failed:`, err),
          );
      }

      // Settle the finished run through the ONE canonical persistence path
      // (finalizeRun, shared with the API's in-process fallback so the two can
      // never drift again — see finalize-run.ts). It writes the snapshot row,
      // flips the run to completed/paused with token usage, advances the project
      // HEAD, and appends the chat row, all transactionally + idempotently.
      const outcome = await finalizeRun(db, {
        runId,
        projectId,
        userId: job.data.userId,
        prompt,
        result,
        creditsPerRun: CREDITS_PER_RUN,
        log: (m) => console.log(`[worker] job=${job.id} ${m}`),
      });

      // NOTE: No credit debit on success — the run cost was RESERVED at enqueue
      // (negative 'reservation' ledger row keyed on runId); a successful run
      // keeps that reservation. The 'failed' handler refunds when a run does not
      // complete; finalizeRun refunds on pause.
      return outcome.paused
        ? { manifestKey: outcome.manifestKey, paused: true }
        : { manifestKey: outcome.manifestKey };
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
  const stuckAfterMs = parsePositiveIntEnv(
    process.env['REAP_STUCK_AFTER_MS'],
    DEFAULT_REAP_STUCK_AFTER_MS,
  );
  const reapIntervalMs = parsePositiveIntEnv(
    process.env['REAP_INTERVAL_MS'],
    DEFAULT_REAP_INTERVAL_MS,
  );

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
          .set({
            status: 'failed',
            abortKind: REAPED_ABORT_KIND,
            updatedAt: new Date(),
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(schema.runs.id, candidate.id),
              inArray(schema.runs.status, ['queued', 'running']),
            ),
          )
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
        .values({
          userId: candidate.userId,
          delta: CREDITS_PER_RUN,
          reason: 'refund',
          runId: candidate.id,
        })
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
  // Last-resort safety net for stray rejections on fire-and-forget paths (e.g.
  // a publish that loses Redis mid-job): log, don't let the process die silently. (C3)
  process.on('unhandledRejection', (reason) => {
    console.error(
      '[playforge-worker] unhandledRejection:',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });

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
        await reapQueue
          .close()
          .catch((err: unknown) => console.error('[reaper] queue close failed:', err));
        await browserClient
          ?.close()
          .catch((err: unknown) => console.error('[browser-jobs] close failed:', err));
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
