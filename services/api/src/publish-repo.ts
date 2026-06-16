import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { type Db, schema } from '@playforge/db';

export interface PublishedGame {
  id: string;
  projectId: string;
  publishSlug: string;
  title: string;
  bundleKey: string;
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
  }): Promise<PublishedGame>;
  getBySlug(slug: string): Promise<PublishedGame | null>;
  getByProject(projectId: string): Promise<PublishedGame | null>;
}

function rowToPublishedGame(row: typeof schema.publishedGames.$inferSelect): PublishedGame {
  return {
    id: row.id,
    projectId: row.projectId,
    publishSlug: row.publishSlug,
    title: row.title,
    bundleKey: row.bundleKey,
    status: row.status,
    publishedAt: row.publishedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class InMemoryPublishRepo implements PublishRepo {
  private readonly byId = new Map<string, PublishedGame>();

  async upsert(input: { projectId: string; publishSlug: string; title: string; bundleKey: string }): Promise<PublishedGame> {
    const existing = [...this.byId.values()].find((g) => g.projectId === input.projectId);
    const now = new Date().toISOString();
    if (existing) {
      const updated: PublishedGame = { ...existing, ...input, updatedAt: now };
      this.byId.set(existing.id, updated);
      return updated;
    }
    const game: PublishedGame = {
      id: randomUUID(),
      ...input,
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
}

export class DrizzlePublishRepo implements PublishRepo {
  constructor(private readonly db: Db) {}

  async upsert(input: { projectId: string; publishSlug: string; title: string; bundleKey: string }): Promise<PublishedGame> {
    const existing = await this.db.query.publishedGames.findFirst({
      where: eq(schema.publishedGames.projectId, input.projectId),
    });
    if (existing) {
      const [row] = await this.db
        .update(schema.publishedGames)
        .set({ bundleKey: input.bundleKey, title: input.title, updatedAt: new Date() })
        .where(eq(schema.publishedGames.id, existing.id))
        .returning();
      if (!row) throw new Error('publish upsert returned no row');
      return rowToPublishedGame(row);
    }
    const id = randomUUID();
    const [row] = await this.db
      .insert(schema.publishedGames)
      .values({ id, projectId: input.projectId, publishSlug: input.publishSlug, title: input.title, bundleKey: input.bundleKey })
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
}
