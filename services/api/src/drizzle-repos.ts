/**
 * Drizzle-backed implementations of ProjectRepo, RunRepo, and ChatRepo over
 * @playforge/db.
 *
 * Swap InMemory* for these at boot when DATABASE_URL is available. Interface
 * contracts are identical; routes and tests need no changes.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Db, schema } from '@playforge/db';
import type { ChatMessageKind } from '@playforge/shared';
import type { ChatMessage, ChatRepo } from './chat-repo';
import type { CreateProjectInput, Engine, Project, ProjectRepo, Visibility } from './repo';
import type { CreateRunInput, Run, RunRepo, RunStats } from './run-repo';
import type { SnapshotEntry, SnapshotRepo, SnapshotEngine } from './snapshot-repo';

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
    ...(row.snapshotManifestKey !== null
      ? { snapshotManifestKey: row.snapshotManifestKey }
      : {}),
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
      .set({ currentSnapshotId: snapshotId, currentManifestKey: manifestKey, updatedAt: new Date() })
      .where(eq(schema.projects.id, id));
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
        and(
          eq(schema.runs.userId, userId),
          inArray(schema.runs.status, ['queued', 'running']),
        ),
      );
    return row?.count ?? 0;
  }

  async getPausedContinuation(projectId: string): Promise<{ continuation: unknown; snapshotManifestKey: string | null } | null> {
    const row = await this.db.query.runs.findFirst({
      where: and(eq(schema.runs.projectId, projectId), eq(schema.runs.status, 'paused')),
      orderBy: [desc(schema.runs.createdAt)],
    });
    if (!row?.continuation) return null;
    return { continuation: row.continuation, snapshotManifestKey: row.snapshotManifestKey ?? null };
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
}
