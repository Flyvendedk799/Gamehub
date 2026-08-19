/**
 * Drizzle-backed implementations of ProjectRepo, RunRepo, and ChatRepo over
 * @playforge/db.
 *
 * Swap InMemory* for these at boot when DATABASE_URL is available. Interface
 * contracts are identical; routes and tests need no changes.
 */
import { randomUUID } from 'node:crypto';
import { type Db, schema } from '@playforge/db';
import {
  type ChatMessageKind,
  JAM_MAX_PLAYERS,
  type JamPhase,
  type JamPlayer,
  type JamState,
  generateJamCode,
  jamColorForSeat,
  jamRoundPlan,
} from '@playforge/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ChatMessage, ChatRepo } from './chat-repo';
import type { CloudSaveRepo } from './cloud-save-repo';
import {
  type CreateJamInput,
  type JamJoinFailure,
  type JamPhasePatch,
  type JamRepo,
  type JamSeat,
  type JamSummary,
  type JoinJamInput,
  assembleJamState,
  hashJamToken,
  mintJamToken,
} from './jam-repo';
import type { CreateProjectInput, Engine, Project, ProjectRepo, Visibility } from './repo';
import type {
  CreateRunInput,
  ProjectSocialMetrics,
  Run,
  RunRepo,
  RunRuntimeUpdate,
  RunStats,
} from './run-repo';
import type {
  AppendSnapshotInput,
  SnapshotEngine,
  SnapshotEntry,
  SnapshotRepo,
} from './snapshot-repo';

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'game'}-${id.slice(0, 8)}`;
}

function rowToProject(row: typeof schema.projects.$inferSelect): Project {
  return {
    id: row.id,
    ownerId: row.ownerId,
    slug: row.slug,
    name: row.name,
    engine: (row.engine ?? null) as Engine | null,
    visibility: row.visibility as Visibility,
    currentSnapshotId: row.currentSnapshotId ?? null,
    currentManifestKey: row.currentManifestKey ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    remixOfProjectId: row.remixOfProjectId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const RUN_STATUS_MAP: Record<string, Run['status']> = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  // `paused` and `canceled` are first-class run states (Phase 2): the SSE relay
  // closes on a paused/canceled run, the resume flow reads `paused`, and the
  // cancel endpoint persists `canceled`. They must round-trip faithfully — the
  // old map collapsed paused→running and canceled→failed, hiding both states.
  paused: 'paused',
  canceled: 'canceled',
};

function rowToRun(row: typeof schema.runs.$inferSelect): Run {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    status: RUN_STATUS_MAP[row.status] ?? 'failed',
    createdAt: row.createdAt.toISOString(),
    ...(row.snapshotManifestKey !== null ? { snapshotManifestKey: row.snapshotManifestKey } : {}),
  };
}

function rowToChatMessage(row: typeof schema.chatMessages.$inferSelect): ChatMessage {
  return {
    id: Number(row.id),
    projectId: row.projectId,
    seq: row.seq,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── ProjectRepo ───────────────────────────────────────────────────────────────

export class DrizzleProjectRepo implements ProjectRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const id = randomUUID();
    const name = input.name ?? 'Untitled game';
    const [row] = await this.db
      .insert(schema.projects)
      .values({
        id,
        slug: slugify(name, id),
        ownerId: input.ownerId,
        name,
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.remixOfProjectId !== undefined
          ? { remixOfProjectId: input.remixOfProjectId }
          : {}),
      })
      .returning();
    if (!row) throw new Error('project insert returned no row');
    return rowToProject(row);
  }

  async get(id: string): Promise<Project | null> {
    const row = await this.db.query.projects.findFirst({
      where: and(eq(schema.projects.id, id), isNull(schema.projects.deletedAt)),
    });
    return row ? rowToProject(row) : null;
  }

  async listByOwner(ownerId: string): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.ownerId, ownerId), isNull(schema.projects.deletedAt)))
      .orderBy(desc(schema.projects.updatedAt));
    return rows.map(rowToProject);
  }

  async rename(id: string, ownerId: string, name: string): Promise<Project | null> {
    const [row] = await this.db
      .update(schema.projects)
      .set({ name, slug: slugify(name, id), updatedAt: new Date() })
      .where(
        and(
          eq(schema.projects.id, id),
          eq(schema.projects.ownerId, ownerId),
          isNull(schema.projects.deletedAt),
        ),
      )
      .returning();
    return row ? rowToProject(row) : null;
  }

  async softDelete(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db
      .update(schema.projects)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(schema.projects.id, id),
          eq(schema.projects.ownerId, ownerId),
          isNull(schema.projects.deletedAt),
        ),
      )
      .returning({ id: schema.projects.id });
    return result.length > 0;
  }

  async setCurrentManifestKey(id: string, manifestKey: string): Promise<void> {
    await this.db
      .update(schema.projects)
      .set({ currentManifestKey: manifestKey, updatedAt: new Date() })
      .where(eq(schema.projects.id, id));
  }

  async setCurrentSnapshot(id: string, snapshotId: string, manifestKey: string): Promise<void> {
    await this.db
      .update(schema.projects)
      .set({
        currentSnapshotId: snapshotId,
        currentManifestKey: manifestKey,
        updatedAt: new Date(),
      })
      .where(eq(schema.projects.id, id));
  }

  async setThumbnail(id: string, thumbnailUrl: string): Promise<void> {
    // Don't bump updatedAt — a thumbnail refresh shouldn't reorder the dashboard.
    await this.db.update(schema.projects).set({ thumbnailUrl }).where(eq(schema.projects.id, id));
  }
}

// ── RunRepo ───────────────────────────────────────────────────────────────────

export class DrizzleRunRepo implements RunRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateRunInput): Promise<Run> {
    const id = randomUUID();
    const [row] = await this.db
      .insert(schema.runs)
      .values({ id, projectId: input.projectId, userId: input.userId })
      .returning();
    if (!row) throw new Error('run insert returned no row');
    return rowToRun(row);
  }

  async get(id: string): Promise<Run | null> {
    const row = await this.db.query.runs.findFirst({ where: eq(schema.runs.id, id) });
    return row ? rowToRun(row) : null;
  }

  async updateStatus(id: string, status: Run['status']): Promise<void> {
    await this.db
      .update(schema.runs)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.runs.id, id));
  }

  async setSnapshot(id: string, manifestKey: string): Promise<void> {
    await this.db
      .update(schema.runs)
      .set({
        snapshotManifestKey: manifestKey,
        status: 'completed',
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(schema.runs.id, id));
  }

  async countActiveByUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(
        and(eq(schema.runs.userId, userId), inArray(schema.runs.status, ['queued', 'running'])),
      );
    return row?.count ?? 0;
  }

  async getPausedContinuation(
    projectId: string,
  ): Promise<{ continuation: unknown; snapshotManifestKey: string | null } | null> {
    const row = await this.db.query.runs.findFirst({
      where: and(eq(schema.runs.projectId, projectId), eq(schema.runs.status, 'paused')),
      orderBy: [desc(schema.runs.createdAt)],
    });
    if (!row?.continuation) return null;
    return { continuation: row.continuation, snapshotManifestKey: row.snapshotManifestKey ?? null };
  }

  async getActiveByProject(projectId: string): Promise<Run | null> {
    // The project's most recent run, returned only if it is still non-terminal —
    // so a project whose latest run finished returns null, never a stale earlier
    // paused run. Lets the web app re-attach to a live run after a page reload.
    const row = await this.db.query.runs.findFirst({
      where: eq(schema.runs.projectId, projectId),
      orderBy: [desc(schema.runs.createdAt)],
    });
    if (!row) return null;
    const run = rowToRun(row);
    return run.status === 'queued' || run.status === 'running' || run.status === 'paused'
      ? run
      : null;
  }

  async getStats(): Promise<RunStats> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${schema.runs.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${schema.runs.status} = 'failed')::int`,
        active: sql<number>`count(*) filter (where ${schema.runs.status} in ('queued','running'))::int`,
      })
      .from(schema.runs);
    const total = row?.total ?? 0;
    const completed = row?.completed ?? 0;
    const failed = row?.failed ?? 0;
    const active = row?.active ?? 0;
    return { total, completed, failed, active, successRate: total > 0 ? completed / total : 0 };
  }

  async setRuntime(id: string, update: RunRuntimeUpdate): Promise<void> {
    await this.db
      .update(schema.runs)
      .set({
        aiStartedAt: update.startedAt,
        aiFinishedAt: update.finishedAt,
        aiRuntimeMs: update.runtimeMs,
        updatedAt: new Date(),
      })
      .where(eq(schema.runs.id, id));
  }

  async getProjectSocialMetrics(projectId: string): Promise<ProjectSocialMetrics> {
    // Headline metrics for the social-outro card: only completed runs that
    // produced a snapshot (excludes failed/canceled/queued/running/paused).
    // bigint sums come back as strings from pg — Number() them on read.
    const [row] = await this.db
      .select({
        promptLoops: sql<number>`count(*)::int`,
        aiRuntimeMs: sql<number>`coalesce(sum(${schema.runs.aiRuntimeMs}), 0)::int`,
        inputTokens: sql<string>`coalesce(sum(${schema.runs.inputTokens}), 0)::bigint`,
        outputTokens: sql<string>`coalesce(sum(${schema.runs.outputTokens}), 0)::bigint`,
        cachedInputTokens: sql<string>`coalesce(sum(${schema.runs.cachedInputTokens}), 0)::bigint`,
        cacheCreationInputTokens: sql<string>`coalesce(sum(${schema.runs.cacheCreationInputTokens}), 0)::bigint`,
      })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.projectId, projectId),
          eq(schema.runs.status, 'completed'),
          sql`${schema.runs.snapshotManifestKey} is not null`,
        ),
      );
    if (!row) {
      return {
        aiRuntimeMs: 0,
        promptLoops: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    }
    return {
      aiRuntimeMs: Number(row.aiRuntimeMs),
      promptLoops: Number(row.promptLoops),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cachedInputTokens: Number(row.cachedInputTokens),
      cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
    };
  }
}

// ── ChatRepo ──────────────────────────────────────────────────────────────────

export class DrizzleChatRepo implements ChatRepo {
  constructor(private readonly db: Db) {}

  async add(projectId: string, kind: ChatMessageKind, payload: unknown): Promise<ChatMessage> {
    const [maxRow] = await this.db
      .select({ val: sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), -1)` })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.projectId, projectId));
    const nextSeq = (maxRow?.val ?? -1) + 1;
    const [row] = await this.db
      .insert(schema.chatMessages)
      .values({ projectId, seq: nextSeq, kind, payload })
      .returning();
    if (!row) throw new Error('chat insert returned no row');
    return rowToChatMessage(row);
  }

  async list(projectId: string): Promise<ChatMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.projectId, projectId))
      .orderBy(asc(schema.chatMessages.seq));
    return rows.map(rowToChatMessage);
  }
}

// ── SnapshotRepo ──────────────────────────────────────────────────────────────

function rowToSnapshotEntry(row: typeof schema.snapshots.$inferSelect): SnapshotEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId ?? null,
    seq: row.seq,
    type: row.type as SnapshotEntry['type'],
    prompt: row.prompt ?? null,
    engine: (row.engine ?? null) as SnapshotEngine | null,
    gameSpec: (row.gameSpec ?? null) as SnapshotEntry['gameSpec'],
    tweakSchema: (row.tweakSchema ?? null) as Record<string, unknown> | null,
    filesManifestKey: row.filesManifestKey,
    filesHash: row.filesHash,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleSnapshotRepo implements SnapshotRepo {
  constructor(private readonly db: Db) {}

  async listByProject(projectId: string): Promise<SnapshotEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.projectId, projectId))
      .orderBy(desc(schema.snapshots.seq));
    return rows.map(rowToSnapshotEntry);
  }

  async getById(snapshotId: string): Promise<SnapshotEntry | null> {
    const [row] = await this.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.id, snapshotId));
    return row ? rowToSnapshotEntry(row) : null;
  }

  /**
   * Append a new snapshot version, allocating the next per-project `seq` under a
   * project-row FOR UPDATE lock (mirrors the worker's finalizeRun completion so
   * seq allocation can't collide with a concurrent generation). Retries once on
   * the UNIQUE (project_id, seq) guard.
   */
  async append(input: AppendSnapshotInput): Promise<SnapshotEntry> {
    const row = await this.db.transaction(async (tx) => {
      // Serialize seq allocation + HEAD advance against concurrent writers.
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, input.projectId))
        .for('update');

      for (let attempt = 0; attempt < 2; attempt++) {
        const [seqRow] = await tx
          .select({ val: sql<number>`COALESCE(MAX(${schema.snapshots.seq}), -1)` })
          .from(schema.snapshots)
          .where(eq(schema.snapshots.projectId, input.projectId));
        const nextSeq = (seqRow?.val ?? -1) + 1 + attempt;
        try {
          const [inserted] = await tx
            .insert(schema.snapshots)
            .values({
              projectId: input.projectId,
              ...(input.parentId != null ? { parentId: input.parentId } : {}),
              seq: nextSeq,
              type: input.type,
              ...(input.prompt != null ? { prompt: input.prompt } : {}),
              ...(input.gameSpec != null ? { gameSpec: input.gameSpec } : {}),
              ...(input.engine != null ? { engine: input.engine } : {}),
              ...(input.tweakSchema != null ? { tweakSchema: input.tweakSchema } : {}),
              filesManifestKey: input.filesManifestKey,
              filesHash: input.filesHash,
            })
            .returning();
          if (inserted) return inserted;
        } catch (insErr) {
          if (attempt === 1) throw insErr;
        }
      }
      throw new Error('snapshot append failed: seq allocation exhausted');
    });
    return rowToSnapshotEntry(row);
  }
}

// ── CloudSaveRepo ───────────────────────────────────────────────────────────────

export class DrizzleCloudSaveRepo implements CloudSaveRepo {
  constructor(private readonly db: Db) {}

  async get(userId: string, projectId: string, key: string): Promise<unknown | null> {
    const [row] = await this.db
      .select({ value: schema.cloudSaves.value })
      .from(schema.cloudSaves)
      .where(
        and(
          eq(schema.cloudSaves.userId, userId),
          eq(schema.cloudSaves.projectId, projectId),
          eq(schema.cloudSaves.saveKey, key),
        ),
      );
    return row ? row.value : null;
  }

  async set(userId: string, projectId: string, key: string, value: unknown): Promise<void> {
    await this.db
      .insert(schema.cloudSaves)
      .values({ userId, projectId, saveKey: key, value })
      .onConflictDoUpdate({
        target: [schema.cloudSaves.userId, schema.cloudSaves.projectId, schema.cloudSaves.saveKey],
        set: { value, updatedAt: new Date() },
      });
  }

  async countKeys(userId: string, projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.cloudSaves)
      .where(and(eq(schema.cloudSaves.userId, userId), eq(schema.cloudSaves.projectId, projectId)));
    return row?.n ?? 0;
  }

  async clearKey(userId: string, projectId: string, key: string): Promise<void> {
    await this.db
      .delete(schema.cloudSaves)
      .where(
        and(
          eq(schema.cloudSaves.userId, userId),
          eq(schema.cloudSaves.projectId, projectId),
          eq(schema.cloudSaves.saveKey, key),
        ),
      );
  }

  async clearProject(userId: string, projectId: string): Promise<void> {
    await this.db
      .delete(schema.cloudSaves)
      .where(and(eq(schema.cloudSaves.userId, userId), eq(schema.cloudSaves.projectId, projectId)));
  }
}

// ── JamRepo ─────────────────────────────────────────────────────────────────────

/**
 * Drizzle-backed Game Jam room store.
 *
 * Reads assemble the broadcastable `JamState` from four tables (room, players,
 * answers, vote counts) in one round of queries and hand it to the shared
 * `assembleJamState`, so the wire shape is identical to the in-memory repo the
 * route tests run against.
 */
export class DrizzleJamRepo implements JamRepo {
  constructor(private readonly db: Db) {}

  /**
   * A room code free among LIVE rooms. The partial unique index is the real
   * guarantee (a concurrent create still 23505s and we retry); this pre-check
   * just keeps the common path from burning an insert.
   */
  private async freshCode(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const code = generateJamCode();
      const [taken] = await this.db
        .select({ id: schema.jams.id })
        .from(schema.jams)
        .where(and(eq(schema.jams.code, code), isNull(schema.jams.endedAt)))
        .limit(1);
      if (!taken) return code;
    }
    throw new Error('jam_code_space_exhausted');
  }

  async create(input: CreateJamInput): Promise<{ state: JamState; seat: JamSeat }> {
    const token = mintJamToken();
    const roundPromptIds = jamRoundPlan(input.config.rounds).map((c) => c.id);

    // Retry on the live-code unique violation: two hosts can pick the same code
    // between the pre-check and the insert, and the loser should just get a new
    // code rather than a 500.
    let jamId: string | null = null;
    for (let attempt = 0; attempt < 5 && jamId === null; attempt++) {
      const code = await this.freshCode();
      try {
        const [row] = await this.db
          .insert(schema.jams)
          .values({ code, hostUserId: input.hostUserId, config: input.config, roundPromptIds })
          .returning({ id: schema.jams.id });
        jamId = row?.id ?? null;
      } catch (err) {
        const code23505 = (err as { code?: string } | null)?.code === '23505';
        if (!code23505 || attempt === 4) throw err;
      }
    }
    if (jamId === null) throw new Error('jam_create_failed');

    const [player] = await this.db
      .insert(schema.jamPlayers)
      .values({
        jamId,
        userId: input.hostUserId,
        tokenHash: hashJamToken(token),
        name: input.hostName,
        color: jamColorForSeat(0).id,
        seat: 0,
      })
      .returning({ id: schema.jamPlayers.id });
    const playerId = player?.id;
    if (playerId === undefined) throw new Error('jam_host_seat_failed');

    await this.db
      .update(schema.jams)
      .set({ hostPlayerId: playerId })
      .where(eq(schema.jams.id, jamId));

    const state = await this.getState(jamId);
    if (!state) throw new Error('jam_create_failed');
    return { state, seat: { playerId, token } };
  }

  async findLiveIdByCode(code: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: schema.jams.id })
      .from(schema.jams)
      .where(and(eq(schema.jams.code, code), isNull(schema.jams.endedAt)))
      .limit(1);
    return row?.id ?? null;
  }

  async getState(jamId: string): Promise<JamState | null> {
    const [jam] = await this.db
      .select()
      .from(schema.jams)
      .where(eq(schema.jams.id, jamId))
      .limit(1);
    if (!jam) return null;

    const playerRows = await this.db
      .select()
      .from(schema.jamPlayers)
      .where(eq(schema.jamPlayers.jamId, jamId))
      .orderBy(asc(schema.jamPlayers.seat));

    const answerRows = await this.db
      .select({
        id: schema.jamAnswers.id,
        round: schema.jamAnswers.round,
        promptId: schema.jamAnswers.promptId,
        playerId: schema.jamAnswers.playerId,
        text: schema.jamAnswers.text,
        createdAt: schema.jamAnswers.createdAt,
        votes: sql<number>`(
          SELECT count(*)::int FROM ${schema.jamVotes}
          WHERE ${schema.jamVotes.answerId} = ${schema.jamAnswers.id}
        )`,
      })
      .from(schema.jamAnswers)
      .where(eq(schema.jamAnswers.jamId, jamId))
      .orderBy(asc(schema.jamAnswers.round), asc(schema.jamAnswers.createdAt));

    return assembleJamState({
      id: jam.id,
      code: jam.code,
      hostPlayerId: jam.hostPlayerId ?? '',
      phase: jam.phase,
      config: jam.config,
      round: jam.round,
      roundPromptIds: jam.roundPromptIds,
      players: playerRows
        .filter((p) => p.leftAt === null)
        .map((p) => ({
          id: p.id,
          userId: p.userId ?? null,
          name: p.name,
          color: p.color,
          seat: p.seat,
          isHost: p.id === jam.hostPlayerId,
          connected: false,
          joinedAt: p.joinedAt.toISOString(),
        })),
      answers: answerRows.map((a) => ({
        id: a.id,
        round: a.round,
        promptId: a.promptId,
        playerId: a.playerId,
        text: a.text,
        votes: Number(a.votes ?? 0),
        createdAt: a.createdAt.toISOString(),
      })),
      deadlineAt: jam.deadlineAt?.getTime() ?? null,
      projectId: jam.projectId ?? null,
      runId: jam.runId ?? null,
      playSlug: jam.playSlug ?? null,
      createdAt: jam.createdAt.toISOString(),
      updatedAt: jam.updatedAt.toISOString(),
    });
  }

  async join(
    jamId: string,
    input: JoinJamInput,
  ): Promise<{ seat: JamSeat } | { error: JamJoinFailure }> {
    const [jam] = await this.db
      .select({ phase: schema.jams.phase, endedAt: schema.jams.endedAt })
      .from(schema.jams)
      .where(eq(schema.jams.id, jamId))
      .limit(1);
    if (!jam || jam.endedAt !== null) return { error: 'closed' };
    // Late joins are welcome while the room is still writing ideas; once the
    // build starts the roster is baked into the brief, so the room is closed.
    if (jam.phase === 'building' || jam.phase === 'ready' || jam.phase === 'ended') {
      return { error: 'closed' };
    }

    const token = mintJamToken();
    // Seat numbers never recycle within a room, so a rejoining player can't
    // steal a departed player's color mid-jam. The (jam_id, seat) unique index
    // makes concurrent joins safe: the loser retries onto the next seat.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [agg] = await this.db
        .select({
          active: sql<number>`count(*) FILTER (WHERE ${schema.jamPlayers.leftAt} IS NULL)::int`,
          nextSeat: sql<number>`COALESCE(MAX(${schema.jamPlayers.seat}) + 1, 0)::int`,
        })
        .from(schema.jamPlayers)
        .where(eq(schema.jamPlayers.jamId, jamId));
      if ((agg?.active ?? 0) >= JAM_MAX_PLAYERS) return { error: 'full' };
      const seat = agg?.nextSeat ?? 0;
      try {
        const [row] = await this.db
          .insert(schema.jamPlayers)
          .values({
            jamId,
            userId: input.userId,
            tokenHash: hashJamToken(token),
            name: input.name,
            color: jamColorForSeat(seat).id,
            seat,
          })
          .returning({ id: schema.jamPlayers.id });
        if (row?.id !== undefined) return { seat: { playerId: row.id, token } };
      } catch (err) {
        if ((err as { code?: string } | null)?.code !== '23505') throw err;
      }
    }
    return { error: 'full' };
  }

  async resolveSeat(jamId: string, token: string): Promise<JamPlayer | null> {
    const [jam] = await this.db
      .select({ hostPlayerId: schema.jams.hostPlayerId })
      .from(schema.jams)
      .where(eq(schema.jams.id, jamId))
      .limit(1);
    if (!jam) return null;
    const [row] = await this.db
      .select()
      .from(schema.jamPlayers)
      .where(
        and(
          eq(schema.jamPlayers.jamId, jamId),
          eq(schema.jamPlayers.tokenHash, hashJamToken(token)),
          isNull(schema.jamPlayers.leftAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId ?? null,
      name: row.name,
      color: row.color,
      seat: row.seat,
      isHost: row.id === jam.hostPlayerId,
      connected: false,
      joinedAt: row.joinedAt.toISOString(),
    };
  }

  async leave(jamId: string, playerId: string): Promise<void> {
    await this.db
      .update(schema.jamPlayers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(schema.jamPlayers.jamId, jamId),
          eq(schema.jamPlayers.id, playerId),
          isNull(schema.jamPlayers.leftAt),
        ),
      );
    await this.touch(jamId);
  }

  async transferHost(jamId: string, playerId: string): Promise<void> {
    // Only to a seat that is still in the room — handing the room to someone who
    // already walked out would brick it just as thoroughly as not handing it on.
    const [next] = await this.db
      .select({ id: schema.jamPlayers.id })
      .from(schema.jamPlayers)
      .where(
        and(
          eq(schema.jamPlayers.jamId, jamId),
          eq(schema.jamPlayers.id, playerId),
          isNull(schema.jamPlayers.leftAt),
        ),
      )
      .limit(1);
    if (!next) return;
    await this.db
      .update(schema.jams)
      .set({ hostPlayerId: playerId, updatedAt: new Date() })
      .where(eq(schema.jams.id, jamId));
  }

  async setPhase(jamId: string, phase: JamPhase, patch?: JamPhasePatch): Promise<void> {
    await this.db
      .update(schema.jams)
      .set({
        phase,
        updatedAt: new Date(),
        ...(patch?.round !== undefined ? { round: patch.round } : {}),
        ...(patch?.deadlineAt !== undefined
          ? { deadlineAt: patch.deadlineAt === null ? null : new Date(patch.deadlineAt) }
          : {}),
        ...(phase === 'ended' ? { endedAt: new Date() } : {}),
      })
      .where(eq(schema.jams.id, jamId));
  }

  async submitAnswer(input: {
    jamId: string;
    playerId: string;
    round: number;
    promptId: string;
    text: string;
  }): Promise<void> {
    await this.db
      .insert(schema.jamAnswers)
      .values({
        jamId: input.jamId,
        playerId: input.playerId,
        round: input.round,
        promptId: input.promptId,
        text: input.text,
      })
      // Re-submitting EDITS the existing answer instead of stacking a second
      // one — what a player expects when fixing a typo before the reveal.
      .onConflictDoUpdate({
        target: [schema.jamAnswers.jamId, schema.jamAnswers.playerId, schema.jamAnswers.round],
        set: { text: input.text, promptId: input.promptId },
      });
    await this.touch(input.jamId);
  }

  async toggleVote(jamId: string, answerId: string, voterPlayerId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.jamVotes)
      .where(
        and(
          eq(schema.jamVotes.answerId, answerId),
          eq(schema.jamVotes.voterPlayerId, voterPlayerId),
        ),
      )
      .returning({ answerId: schema.jamVotes.answerId });
    if (deleted.length > 0) {
      await this.touch(jamId);
      return false;
    }
    await this.db.insert(schema.jamVotes).values({ answerId, voterPlayerId }).onConflictDoNothing();
    await this.touch(jamId);
    return true;
  }

  async attachBuild(jamId: string, projectId: string, runId: string): Promise<void> {
    await this.db
      .update(schema.jams)
      .set({ projectId, runId, updatedAt: new Date() })
      .where(eq(schema.jams.id, jamId));
  }

  async setPlaySlug(jamId: string, playSlug: string): Promise<void> {
    await this.db
      .update(schema.jams)
      .set({ playSlug, updatedAt: new Date() })
      .where(eq(schema.jams.id, jamId));
  }

  async end(jamId: string): Promise<void> {
    await this.setPhase(jamId, 'ended');
  }

  async listByHost(hostUserId: string): Promise<JamSummary[]> {
    const rows = await this.db
      .select({
        id: schema.jams.id,
        code: schema.jams.code,
        phase: schema.jams.phase,
        projectId: schema.jams.projectId,
        playSlug: schema.jams.playSlug,
        createdAt: schema.jams.createdAt,
        playerCount: sql<number>`(
          SELECT count(*)::int FROM ${schema.jamPlayers}
          WHERE ${schema.jamPlayers.jamId} = ${schema.jams.id}
            AND ${schema.jamPlayers.leftAt} IS NULL
        )`,
        title: sql<string | null>`(
          SELECT ${schema.jamAnswers.text} FROM ${schema.jamAnswers}
          WHERE ${schema.jamAnswers.jamId} = ${schema.jams.id}
            AND ${schema.jamAnswers.promptId} = 'title'
          ORDER BY ${schema.jamAnswers.createdAt} ASC
          LIMIT 1
        )`,
      })
      .from(schema.jams)
      .where(eq(schema.jams.hostUserId, hostUserId))
      .orderBy(desc(schema.jams.createdAt))
      .limit(50);

    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      phase: r.phase,
      playerCount: Number(r.playerCount ?? 0),
      title: r.title ?? null,
      projectId: r.projectId ?? null,
      playSlug: r.playSlug ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Bump `updated_at` so pollers/broadcasts see the room changed. */
  private async touch(jamId: string): Promise<void> {
    await this.db
      .update(schema.jams)
      .set({ updatedAt: new Date() })
      .where(eq(schema.jams.id, jamId));
  }
}
