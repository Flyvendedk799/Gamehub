import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { type Db, schema } from '@playforge/db';

export interface PublishedGame {
  id: string;
  projectId: string;
  /** The IMMUTABLE snapshot that was published. Remix forks this, not the live
   *  project HEAD, so post-publish WIP never leaks. Null for games published
   *  before snapshot-pinning landed. */
  snapshotId: string | null;
  publishSlug: string;
  title: string;
  bundleKey: string;
  thumbnailUrl: string | null;
  status: 'live' | 'unpublished' | 'removed_by_mod';
  publishedAt: string;
  updatedAt: string;
}

export interface PublishRepo {
  upsert(input: {
    projectId: string;
    publishSlug: string;
    title: string;
    bundleKey: string;
    snapshotId?: string;
  }): Promise<PublishedGame>;
  getBySlug(slug: string): Promise<PublishedGame | null>;
  getByProject(projectId: string): Promise<PublishedGame | null>;
  setStatus(id: string, status: PublishedGame['status']): Promise<void>;
  setThumbnailUrl(id: string, thumbnailUrl: string): Promise<void>;
  /** List live published games by project owner — for creator profiles. */
  listByOwner(ownerId: string, opts: { limit: number; offset: number }): Promise<PublishedGame[]>;
}

function rowToPublishedGame(row: typeof schema.publishedGames.$inferSelect): PublishedGame {
  return {
    id: row.id,
    projectId: row.projectId,
    snapshotId: row.snapshotId ?? null,
    publishSlug: row.publishSlug,
    title: row.title,
    bundleKey: row.bundleKey,
    thumbnailUrl: row.thumbnailUrl ?? null,
    status: row.status,
    publishedAt: row.publishedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class InMemoryPublishRepo implements PublishRepo {
  private readonly byId = new Map<string, PublishedGame>();

  async upsert(input: { projectId: string; publishSlug: string; title: string; bundleKey: string; snapshotId?: string }): Promise<PublishedGame> {
    const existing = [...this.byId.values()].find((g) => g.projectId === input.projectId);
    const now = new Date().toISOString();
    const snapshotId = input.snapshotId ?? null;
    if (existing) {
      const updated: PublishedGame = { ...existing, ...input, snapshotId, updatedAt: now };
      this.byId.set(existing.id, updated);
      return updated;
    }
    const game: PublishedGame = {
      id: randomUUID(),
      ...input,
      snapshotId,
      thumbnailUrl: null,
      status: 'live',
      publishedAt: now,
      updatedAt: now,
    };
    this.byId.set(game.id, game);
    return game;
  }

  async getBySlug(slug: string): Promise<PublishedGame | null> {
    return [...this.byId.values()].find((g) => g.publishSlug === slug) ?? null;
  }

  async getByProject(projectId: string): Promise<PublishedGame | null> {
    return [...this.byId.values()].find((g) => g.projectId === projectId) ?? null;
  }

  async setStatus(id: string, status: PublishedGame['status']): Promise<void> {
    const game = this.byId.get(id);
    if (game) this.byId.set(id, { ...game, status, updatedAt: new Date().toISOString() });
  }

  async setThumbnailUrl(id: string, thumbnailUrl: string): Promise<void> {
    const game = this.byId.get(id);
    if (game) this.byId.set(id, { ...game, thumbnailUrl, updatedAt: new Date().toISOString() });
  }

  async listByOwner(_ownerId: string, opts: { limit: number; offset: number }): Promise<PublishedGame[]> {
    return [...this.byId.values()]
      .filter((g) => g.status === 'live')
      .slice(opts.offset, opts.offset + opts.limit);
  }
}

export class DrizzlePublishRepo implements PublishRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: { projectId: string; publishSlug: string; title: string; bundleKey: string; snapshotId?: string }): Promise<PublishedGame> {
    const existing = await this.db.query.publishedGames.findFirst({
      where: eq(schema.publishedGames.projectId, input.projectId),
    });
    if (existing) {
      const [row] = await this.db
        .update(schema.publishedGames)
        .set({
          bundleKey: input.bundleKey,
          title: input.title,
          updatedAt: new Date(),
          ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
        })
        .where(eq(schema.publishedGames.id, existing.id))
        .returning();
      if (!row) throw new Error('publish upsert returned no row');
      return rowToPublishedGame(row);
    }
    const id = randomUUID();
    const [row] = await this.db
      .insert(schema.publishedGames)
      .values({
        id,
        projectId: input.projectId,
        publishSlug: input.publishSlug,
        title: input.title,
        bundleKey: input.bundleKey,
        ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
      })
      .returning();
    if (!row) throw new Error('publish insert returned no row');
    return rowToPublishedGame(row);
  }

  async getBySlug(slug: string): Promise<PublishedGame | null> {
    const row = await this.db.query.publishedGames.findFirst({
      where: eq(schema.publishedGames.publishSlug, slug),
    });
    return row ? rowToPublishedGame(row) : null;
  }

  async getByProject(projectId: string): Promise<PublishedGame | null> {
    const rows = await this.db
      .select()
      .from(schema.publishedGames)
      .where(eq(schema.publishedGames.projectId, projectId))
      .orderBy(desc(schema.publishedGames.publishedAt))
      .limit(1);
    return rows[0] ? rowToPublishedGame(rows[0]) : null;
  }

  async setStatus(id: string, status: PublishedGame['status']): Promise<void> {
    await this.db
      .update(schema.publishedGames)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.publishedGames.id, id));
  }

  async setThumbnailUrl(id: string, thumbnailUrl: string): Promise<void> {
    await this.db
      .update(schema.publishedGames)
      .set({ thumbnailUrl, updatedAt: new Date() })
      .where(eq(schema.publishedGames.id, id));
  }

  async listByOwner(ownerId: string, opts: { limit: number; offset: number }): Promise<PublishedGame[]> {
    const rows = await this.db
      .select({ pg: schema.publishedGames })
      .from(schema.publishedGames)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.publishedGames.projectId))
      .where(
        and(
          eq(schema.projects.ownerId, ownerId),
          eq(schema.publishedGames.status, 'live'),
        ),
      )
      .orderBy(desc(schema.publishedGames.publishedAt))
      .limit(opts.limit)
      .offset(opts.offset);
    return rows.map((r) => rowToPublishedGame(r.pg));
  }
}
