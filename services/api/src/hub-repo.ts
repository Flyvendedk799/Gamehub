import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { type Db, schema } from '@playforge/db';

export interface HubGame {
  id: string;
  projectId: string;
  publishSlug: string;
  title: string;
  status: 'live' | 'unpublished' | 'removed_by_mod';
  playCount: number;
  ratingAvg: number;
  ratingCount: number;
  publishedAt: string;
}

export interface HubComment {
  id: string;
  publishedGameId: string;
  userId: string;
  body: string;
  parentCommentId: string | null;
  createdAt: string;
}

export interface HubRepo {
  feed(opts: { limit: number; offset: number; sort: 'recent' | 'popular' }): Promise<HubGame[]>;
  /** Full-text/semantic search. Pass embedding for pgvector; omit for text fallback. */
  search(opts: { query: string; embedding?: number[]; limit: number }): Promise<HubGame[]>;
  incrementPlayCount(id: string): Promise<void>;
  getLike(userId: string, publishedGameId: string): Promise<boolean>;
  toggleLike(userId: string, publishedGameId: string): Promise<boolean>; // returns new liked state
  setRating(userId: string, publishedGameId: string, stars: number): Promise<{ ratingAvg: number; ratingCount: number }>;
  listComments(publishedGameId: string): Promise<HubComment[]>;
  addComment(publishedGameId: string, userId: string, body: string, parentCommentId?: string): Promise<HubComment>;
  addReport(input: { reporterId?: string; targetType: string; targetId: string; reason?: string }): Promise<void>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
}

// ── InMemoryHubRepo ────────────────────────────────────────────────────────

export class InMemoryHubRepo implements HubRepo {
  private readonly games = new Map<string, HubGame>();
  private readonly likes = new Set<string>(); // `${userId}:${gameId}`
  private readonly ratings = new Map<string, number>(); // `${userId}:${gameId}` → stars
  private readonly comments = new Map<string, HubComment>();
  // reports are fire-and-forget; stored only to satisfy the interface
  private readonly reports: Array<{ reporterId?: string; targetType: string; targetId: string; reason?: string }> = [];

  /** Seed a game for testing. */
  seedGame(game: HubGame): void {
    this.games.set(game.id, game);
  }

  async feed(opts: { limit: number; offset: number; sort: 'recent' | 'popular' }): Promise<HubGame[]> {
    const live = [...this.games.values()].filter((g) => g.status === 'live');
    if (opts.sort === 'popular') {
      live.sort((a, b) => b.playCount - a.playCount);
    } else {
      live.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    }
    return live.slice(opts.offset, opts.offset + opts.limit);
  }

  async incrementPlayCount(id: string): Promise<void> {
    const game = this.games.get(id);
    if (game) {
      this.games.set(id, { ...game, playCount: game.playCount + 1 });
    }
  }

  async getLike(userId: string, publishedGameId: string): Promise<boolean> {
    return this.likes.has(`${userId}:${publishedGameId}`);
  }

  async toggleLike(userId: string, publishedGameId: string): Promise<boolean> {
    const key = `${userId}:${publishedGameId}`;
    if (this.likes.has(key)) {
      this.likes.delete(key);
      return false;
    }
    this.likes.add(key);
    return true;
  }

  async setRating(userId: string, publishedGameId: string, stars: number): Promise<{ ratingAvg: number; ratingCount: number }> {
    const key = `${userId}:${publishedGameId}`;
    this.ratings.set(key, stars);

    // Recompute avg over all ratings for this game.
    const gameRatings = [...this.ratings.entries()]
      .filter(([k]) => k.endsWith(`:${publishedGameId}`))
      .map(([, s]) => s);
    const count = gameRatings.length;
    const avg = count > 0 ? gameRatings.reduce((a, b) => a + b, 0) / count : 0;

    const game = this.games.get(publishedGameId);
    if (game) {
      this.games.set(publishedGameId, { ...game, ratingAvg: avg, ratingCount: count });
    }

    return { ratingAvg: avg, ratingCount: count };
  }

  async listComments(publishedGameId: string): Promise<HubComment[]> {
    return [...this.comments.values()]
      .filter((c) => c.publishedGameId === publishedGameId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async addComment(publishedGameId: string, userId: string, body: string, parentCommentId?: string): Promise<HubComment> {
    const comment: HubComment = {
      id: randomUUID(),
      publishedGameId,
      userId,
      body,
      parentCommentId: parentCommentId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.comments.set(comment.id, comment);
    return comment;
  }

  async addReport(input: { reporterId?: string; targetType: string; targetId: string; reason?: string }): Promise<void> {
    this.reports.push(input);
  }

  async search(opts: { query: string; embedding?: number[]; limit: number }): Promise<HubGame[]> {
    const q = opts.query.toLowerCase();
    const live = [...this.games.values()].filter((g) => g.status === 'live');
    return live.filter((g) => g.title.toLowerCase().includes(q)).slice(0, opts.limit);
  }

  async setEmbedding(_id: string, _embedding: number[]): Promise<void> {
    // No-op for in-memory (tests don't need vector search)
  }
}

// ── DrizzleHubRepo ─────────────────────────────────────────────────────────

function rowToHubGame(row: typeof schema.publishedGames.$inferSelect): HubGame {
  return {
    id: row.id,
    projectId: row.projectId,
    publishSlug: row.publishSlug,
    title: row.title,
    status: row.status,
    playCount: row.playCount,
    ratingAvg: Number(row.ratingAvg),
    ratingCount: row.ratingCount,
    publishedAt: row.publishedAt.toISOString(),
  };
}

function rowToHubComment(row: typeof schema.commentsSocial.$inferSelect): HubComment {
  return {
    id: row.id,
    publishedGameId: row.publishedGameId,
    userId: row.userId,
    body: row.body,
    parentCommentId: row.parentCommentId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleHubRepo implements HubRepo {
  constructor(private readonly db: Db) {}

  async feed(opts: { limit: number; offset: number; sort: 'recent' | 'popular' }): Promise<HubGame[]> {
    const orderBy =
      opts.sort === 'popular'
        ? desc(schema.publishedGames.playCount)
        : desc(schema.publishedGames.publishedAt);

    const rows = await this.db
      .select()
      .from(schema.publishedGames)
      .where(eq(schema.publishedGames.status, 'live'))
      .orderBy(orderBy)
      .limit(opts.limit)
      .offset(opts.offset);

    return rows.map(rowToHubGame);
  }

  async incrementPlayCount(id: string): Promise<void> {
    await this.db
      .update(schema.publishedGames)
      .set({ playCount: sql`${schema.publishedGames.playCount} + 1` })
      .where(eq(schema.publishedGames.id, id));
  }

  async getLike(userId: string, publishedGameId: string): Promise<boolean> {
    const row = await this.db.query.likes.findFirst({
      where: and(
        eq(schema.likes.userId, userId),
        eq(schema.likes.publishedGameId, publishedGameId),
      ),
    });
    return row !== undefined;
  }

  async toggleLike(userId: string, publishedGameId: string): Promise<boolean> {
    const existing = await this.db.query.likes.findFirst({
      where: and(
        eq(schema.likes.userId, userId),
        eq(schema.likes.publishedGameId, publishedGameId),
      ),
    });

    if (existing) {
      await this.db
        .delete(schema.likes)
        .where(
          and(
            eq(schema.likes.userId, userId),
            eq(schema.likes.publishedGameId, publishedGameId),
          ),
        );
      return false;
    }

    await this.db.insert(schema.likes).values({ userId, publishedGameId });
    return true;
  }

  async setRating(userId: string, publishedGameId: string, stars: number): Promise<{ ratingAvg: number; ratingCount: number }> {
    await this.db
      .insert(schema.ratings)
      .values({ userId, publishedGameId, stars })
      .onConflictDoUpdate({
        target: [schema.ratings.userId, schema.ratings.publishedGameId],
        set: { stars, updatedAt: new Date() },
      });

    const [stats] = await this.db
      .select({
        avg: sql<number>`AVG(${schema.ratings.stars})::numeric(5,2)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(schema.ratings)
      .where(eq(schema.ratings.publishedGameId, publishedGameId));

    await this.db
      .update(schema.publishedGames)
      .set({
        ratingAvg: String(stats?.avg ?? 0),
        ratingCount: Number(stats?.count ?? 0),
      })
      .where(eq(schema.publishedGames.id, publishedGameId));

    return {
      ratingAvg: Number(stats?.avg ?? 0),
      ratingCount: Number(stats?.count ?? 0),
    };
  }

  async listComments(publishedGameId: string): Promise<HubComment[]> {
    const rows = await this.db
      .select()
      .from(schema.commentsSocial)
      .where(
        and(
          eq(schema.commentsSocial.publishedGameId, publishedGameId),
          isNull(schema.commentsSocial.deletedAt),
        ),
      )
      .orderBy(asc(schema.commentsSocial.createdAt));

    return rows.map(rowToHubComment);
  }

  async addComment(publishedGameId: string, userId: string, body: string, parentCommentId?: string): Promise<HubComment> {
    const id = randomUUID();
    const [row] = await this.db
      .insert(schema.commentsSocial)
      .values({
        id,
        publishedGameId,
        userId,
        body,
        ...(parentCommentId !== undefined ? { parentCommentId } : {}),
      })
      .returning();

    if (!row) throw new Error('addComment returned no row');
    return rowToHubComment(row);
  }

  async addReport(input: { reporterId?: string; targetType: string; targetId: string; reason?: string }): Promise<void> {
    await this.db.insert(schema.reports).values({
      id: randomUUID(),
      targetType: input.targetType,
      targetId: input.targetId,
      ...(input.reporterId !== undefined ? { reporterId: input.reporterId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  async search(opts: { query: string; embedding?: number[]; limit: number }): Promise<HubGame[]> {
    if (opts.embedding) {
      // pgvector cosine similarity — find games with embeddings closest to the query vector.
      const vectorLiteral = `[${opts.embedding.join(',')}]`;
      const rows = await this.db
        .select()
        .from(schema.publishedGames)
        .where(
          and(
            eq(schema.publishedGames.status, 'live'),
            sql`${schema.publishedGames.embedding} IS NOT NULL`,
          ),
        )
        .orderBy(sql`${schema.publishedGames.embedding} <=> ${vectorLiteral}::vector`)
        .limit(opts.limit);
      return rows.map(rowToHubGame);
    }

    // Text fallback: ILIKE on title and description.
    const rows = await this.db
      .select()
      .from(schema.publishedGames)
      .where(
        and(
          eq(schema.publishedGames.status, 'live'),
          sql`(${schema.publishedGames.title} ILIKE ${'%' + opts.query + '%'}
           OR ${schema.publishedGames.description} ILIKE ${'%' + opts.query + '%'})`,
        ),
      )
      .orderBy(desc(schema.publishedGames.publishedAt))
      .limit(opts.limit);
    return rows.map(rowToHubGame);
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.db
      .update(schema.publishedGames)
      .set({ embedding } as Record<string, unknown>)
      .where(eq(schema.publishedGames.id, id));
  }
}
