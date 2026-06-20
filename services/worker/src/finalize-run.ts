/**
 * finalizeRun — the ONE canonical post-generation persistence path.
 *
 * Both generation entrypoints settle a finished run through this function:
 *   • the BullMQ worker (services/worker/src/main.ts), and
 *   • the API's in-process fallback (services/api/src/main.ts), used when no
 *     REDIS_URL is configured (the ServerHoster single-process deployment).
 *
 * It exists because those two paths had DRIFTED: the worker wrote a full
 * `snapshots` row + advanced `projects.current_snapshot_id` + recorded token
 * usage, while the in-process path only stamped `runs.snapshot_manifest_key`
 * and a chat row. On ServerHoster that silently produced zero snapshot rows
 * (History/Restore/Remix all broken), a NULL current snapshot, and 0/0 token
 * counts — even though generation succeeded. Routing both through one function
 * makes that class of drift impossible.
 *
 * Behaviour (mirrors the worker's transactional completion, #9):
 *   • paused run  → status='paused' + continuation + `continuation_pending`
 *                   chat row, and refund the enqueue-time reservation so a
 *                   pause→resume cycle costs `creditsPerRun` exactly once.
 *   • completed   → ONE transaction: insert a snapshot row (seq under a project
 *                   FOR UPDATE lock), flip the run to 'completed' (+ token
 *                   usage, finishedAt), advance the project HEAD + engine, and
 *                   append the `artifact_delivered` chat row. Idempotent: a
 *                   retry of an already-completed run short-circuits.
 */
import { type Db, schema } from '@playforge/db';
import { eq, sql } from 'drizzle-orm';
import type { EnqueueResult } from './queue';

export interface FinalizeRunArgs {
  runId: string;
  projectId: string;
  userId: string;
  /** The user prompt for this run — stored on the snapshot row. */
  prompt: string;
  result: EnqueueResult;
  /** Credits reserved at enqueue; refunded on pause (resume re-reserves). */
  creditsPerRun: number;
  /** Structured logger. Defaults to console.log. */
  log?: (msg: string) => void;
}

export interface FinalizeRunOutcome {
  manifestKey: string;
  paused: boolean;
  /** The snapshot row id created for a completed run (null when paused or a
   *  duplicate-completion short-circuit returned the existing manifest). */
  snapshotId: string | null;
}

export async function finalizeRun(db: Db, args: FinalizeRunArgs): Promise<FinalizeRunOutcome> {
  const { runId, projectId, userId, prompt, result, creditsPerRun } = args;
  const log = args.log ?? ((m: string) => console.log(m));
  const manifestKey = result.snapshot.manifestKey;
  const usage = result.usage;

  // ── Paused at a safe boundary ─────────────────────────────────────────────
  if (result.pausedContinuation) {
    const [seqRow] = await db
      .select({ val: sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), -1)` })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.projectId, projectId));
    const nextSeq = (seqRow?.val ?? -1) + 1;

    await Promise.all([
      db
        .update(schema.runs)
        .set({
          snapshotManifestKey: manifestKey,
          status: 'paused',
          continuation: result.pausedContinuation as unknown,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cacheReadTokens,
          cacheCreationInputTokens: usage.cacheWriteTokens,
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
        // WS-D — carry the agent's clarifying question (when the pause came from
        // ask_user) so the builder shows it + collects an answer to resume with.
        payload: {
          runId,
          manifestKey,
          ...(result.pendingQuestion ? { question: result.pendingQuestion } : {}),
        },
      }),
    ]);

    // A paused run is non-terminal — refund this run's reservation; the resume
    // run reserves its own. Idempotent via the 'credit_ledger_refund_key'. Only
    // refund if a reservation EXISTS: a BYOK/subscription run isn't platform-
    // funded so it never reserved, and a blind refund would print credits.
    if (userId) {
      const reserved = await db
        .select({ runId: schema.creditLedger.runId })
        .from(schema.creditLedger)
        .where(
          sql`${schema.creditLedger.runId} = ${runId} AND ${schema.creditLedger.reason} = 'reservation'`,
        )
        .limit(1);
      if (reserved.length > 0) {
        await db
          .insert(schema.creditLedger)
          .values({ userId, delta: creditsPerRun, reason: 'refund', runId })
          .onConflictDoNothing()
          .catch((err: unknown) => log(`[run:${runId}] paused-run refund failed: ${String(err)}`));
      }
    }

    log(
      `[run:${runId}] paused at safe boundary — manifest=${manifestKey} ` +
        `tokens=${usage.totalTokens} (in=${usage.inputTokens}/out=${usage.outputTokens})`,
    );
    return { manifestKey, paused: true, snapshotId: null };
  }

  // ── Transactional completion (#9) ─────────────────────────────────────────
  let snapshotId: string | null = null;
  const completedManifestKey = await db.transaction(async (tx) => {
    // Lock the run; short-circuit a retry of an already-completed run.
    const [runRow] = await tx
      .select({ status: schema.runs.status, existingManifest: schema.runs.snapshotManifestKey })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .for('update');
    if (runRow?.status === 'completed') {
      log(`[run:${runId}] already completed — skipping duplicate write`);
      return runRow.existingManifest ?? manifestKey;
    }

    // Lock the project row so snapshot-seq allocation + HEAD advance serialize.
    const [projectRow] = await tx
      .select({ currentSnapshotId: schema.projects.currentSnapshotId })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .for('update');
    const parentSnapshotId = projectRow?.currentSnapshotId ?? null;

    // Allocate the next snapshot seq under the project lock; the UNIQUE
    // (project_id, seq) is the real guard. Retry once on a unique violation.
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
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadTokens,
        cacheCreationInputTokens: usage.cacheWriteTokens,
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

  log(
    `[run:${runId}] completed — manifest=${completedManifestKey} snapshot=${snapshotId ?? 'n/a'} ` +
      `engine=${result.engine ?? 'n/a'} files=${result.fileCount} repairRounds=${result.repairRounds} ` +
      `shipReason=${result.shipReason} tokens=${usage.totalTokens} ` +
      `(in=${usage.inputTokens}/out=${usage.outputTokens}` +
      `/cacheRead=${usage.cacheReadTokens}/cacheWrite=${usage.cacheWriteTokens})`,
  );
  return { manifestKey: completedManifestKey, paused: false, snapshotId };
}
