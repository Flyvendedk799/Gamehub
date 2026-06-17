import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { type Db, schema } from '@playforge/db';

export interface HubGame {
  id: string;
  projectId: string;
  publishSlug: string;
  title: string;
  /** Gallery thumbnail (PNG captured at publish) or null until captured. */
  thumbnailUrl: string | null;
  /** Short description copied from the project's GameSpec at publish. */
  description: string | null;
  /** Genre lifted from the published GameSpec (e.g. 'platformer'). */
  genre: string | null;
  /** Free-form discovery tags persisted at publish. */
  tags: string[];
  /** How many times this game has been remixed (count of remix_edges at depth 1). */
  remixCount: number;
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

export interface HubStats {
  totalPublished: number;
  totalPlays: number;
  totalLikes: number;
  totalComments: number;
}

export type HubSort = 'recent' | 'popular' | 'trending';

export interface HubFeedOpts {
  limit: number;
  offset: number;
  sort: HubSort;
  /** Filter to a single genre (matches the published GameSpec genre). */
  genre?: string;
  /** Filter to games carrying this tag. */
  tag?: string;
}

export interface HubRepo {
  feed(opts: HubFeedOpts): Promise<HubGame[]>;
  /** Full-text/semantic search. Pass embedding for pgvector; omit for text fallback. */
  search(opts: { query: string; embedding?: number[]; limit: number }): Promise<HubGame[]>;
  incrementPlayCount(id: string): Promise<void>;
  /**
   * Record a single play for trending velocity (#3.3). `sessionHash` is the
   * salted-IP throttle key the play route already computes; null for an
   * authenticated/unkeyed play. Best-effort — never blocks the play response.
   */
  recordPlayEvent(input: { publishedGameId: string; userId?: string; sessionHash?: string }): Promise<void>;
  getLike(userId: string, publishedGameId: string): Promise<boolean>;
  toggleLike(userId: string, publishedGameId: string): Promise<boolean>; // returns new liked state
  setRating(userId: string, publishedGameId: string, stars: number): Promise<{ ratingAvg: number; ratingCount: number }>;
  listComments(publishedGameId: string): Promise<HubComment[]>;
  addComment(publishedGameId: string, userId: string, body: string, parentCommentId?: string): Promise<HubComment>;
  addReport(input: { reporterId?: string; targetType: string; targetId: string; reason?: string }): Promise<void>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  /**
   * Record a remix lineage edge (#3.6): a direct depth-1 edge from the source
   * project to the new fork, plus a copy of every ancestor edge of the source
   * at depth+1 so the full tree is queryable. Idempotent on (ancestor, descendant).
   */
  addRemixEdge(input: { ancestorProjectId: string; descendantProjectId: string }): Promise<void>;
  /** Count of direct (depth-1) remixes of a published game's project. */
  remixCount(projectId: string): Promise<number>;
  getStats?(): Promise<HubStats>;
}

// ── InMemoryHubRepo ────────────────────────────────────────────────────────

/** Half-life (ms) of a play in the trending velocity score (#3.3). 24h. */
const TRENDING_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
/** A like is worth this many plays in the trending score. */
const TRENDING_LIKE_WEIGHT = 5;

/** Fill defaults so a partially-specified seed still yields a complete HubGame. */
function normalizeHubGame(game: Partial<HubGame> & Pick<HubGame, 'id' | 'projectId' | 'publishSlug' | 'title' | 'status' | 'publishedAt'>): HubGame {
  return {
    thumbnailUrl: null,
    description: null,
    genre: null,
    tags: [],
    remixCount: 0,
    playCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
    ...game,
  };
}

export class InMemoryHubRepo implements HubRepo {
  private readonly games = new Map<string, HubGame>();
  private readonly likes = new Set<string>(); // `${userId}:${gameId}`
  private readonly ratings = new Map<string, number>(); // `${userId}:${gameId}` → stars
  private readonly comments = new Map<string, HubComment>();
  // reports are fire-and-forget; stored only to satisfy the interface
  private readonly reports: Array<{ reporterId?: string; targetType: string; targetId: string; reason?: string }> = [];
  // play events for trending velocity: gameId → array of epoch-ms timestamps
  private readonly playEvents = new Map<string, number[]>();
  // remix lineage edges: `${ancestorProjectId}:${descendantProjectId}` → depth
  private readonly remixEdges = new Map<string, number>();
  /** Injectable clock so trending tests are deterministic. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Seed a game for testing. Missing optional fields default sensibly. */
  seedGame(game: Partial<HubGame> & Pick<HubGame, 'id' | 'projectId' | 'publishSlug' | 'title' | 'status' | 'publishedAt'>): void {
    const full = normalizeHubGame(game);
    this.games.set(full.id, full);
  }

  /** Compute a time-decayed play/like velocity for a game (higher = hotter). */
  private trendingScore(game: HubGame): number {
    const now = this.now();
    const events = this.playEvents.get(game.id) ?? [];
    let score = 0;
    for (const ts of events) {
      const ageMs = Math.max(now - ts, 0);
      score += Math.pow(0.5, ageMs / TRENDING_HALF_LIFE_MS);
    }
    // Likes count as a steady, non-decayed signal of quality.
    const likeCount = [...this.likes].filter((k) => k.endsWith(`:${game.id}`)).length;
    return score + likeCount * TRENDING_LIKE_WEIGHT;
  }

  async feed(opts: HubFeedOpts): Promise<HubGame[]> {
    let live = [...this.games.values()].filter((g) => g.status === 'live');
    if (opts.genre !== undefined) live = live.filter((g) => g.genre === opts.genre);
    if (opts.tag !== undefined) live = live.filter((g) => g.tags.includes(opts.tag as string));
    if (opts.sort === 'popular') {
      live.sort((a, b) => b.playCount - a.playCount);
    } else if (opts.sort === 'trending') {
      live.sort((a, b) => this.trendingScore(b) - this.trendingScore(a));
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

  async recordPlayEvent(input: { publishedGameId: string; userId?: string; sessionHash?: string }): Promise<void> {
    const list = this.playEvents.get(input.publishedGameId) ?? [];
    list.push(this.now());
    this.playEvents.set(input.publishedGameId, list);
  }

  async addRemixEdge(input: { ancestorProjectId: string; descendantProjectId: string }): Promise<void> {
    // Direct depth-1 edge.
    this.setRemixEdge(input.ancestorProjectId, input.descendantProjectId, 1);
    // Copy every ancestor edge of the source at depth+1 so the full tree is queryable.
    for (const [key, depth] of this.remixEdges) {
      const parts = key.split(':');
      const anc = parts[0];
      const desc = parts[1];
      if (anc !== undefined && desc === input.ancestorProjectId) {
        this.setRemixEdge(anc, input.descendantProjectId, depth + 1);
      }
    }
  }

  private setRemixEdge(ancestor: string, descendant: string, depth: number): void {
    const key = `${ancestor}:${descendant}`;
    const existing = this.remixEdges.get(key);
    // Keep the shallowest depth if the edge already exists (idempotent).
    if (existing === undefined || depth < existing) this.remixEdges.set(key, depth);
    // Reflect the new direct-remix count onto any matching game shape.
    if (depth === 1) {
      for (const game of this.games.values()) {
        if (game.projectId === ancestor) {
          this.games.set(game.id, { ...game, remixCount: this.directRemixCount(ancestor) });
        }
      }
    }
  }

  private directRemixCount(projectId: string): number {
    let n = 0;
    for (const [key, depth] of this.remixEdges) {
      if (depth === 1 && key.startsWith(`${projectId}:`)) n += 1;
    }
    return n;
  }

  async remixCount(projectId: string): Promise<number> {
    return this.directRemixCount(projectId);
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

  async getStats(): Promise<HubStats> {
    const games = [...this.games.values()].filter((g) => g.status === 'live');
    return {
      totalPublished: games.length,
      totalPlays: games.reduce((n, g) => n + g.playCount, 0),
      totalLikes: this.likes.size,
      totalComments: this.comments.size,
    };
  }
}

// ── DrizzleHubRepo ─────────────────────────────────────────────────────────

function rowToHubGame(row: typeof schema.publishedGames.$inferSelect, remixCount = 0): HubGame {
  const spec = row.gameSpec as { genre?: unknown } | null;
  const genre = typeof spec?.genre === 'string' ? spec.genre : null;
  return {
    id: row.id,
    projectId: row.projectId,
    publishSlug: row.publishSlug,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl ?? null,
    description: row.description ?? null,
    genre,
    tags: row.tags ?? [],
    remixCount,
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

  async feed(opts: HubFeedOpts): Promise<HubGame[]> {
    // Time-decayed play/like velocity for trending. A 24h half-life on play
    // events plus a non-decayed like weight (#3.3). Computed as correlated
    // subqueries so we can ORDER BY the score without a materialized view.
    const halfLifeMs = 24 * 60 * 60 * 1000;
    const trendingScore = sql<number>`(
      COALESCE((
        SELECT SUM(POWER(0.5, EXTRACT(EPOCH FROM (now() - pe.created_at)) * 1000.0 / ${halfLifeMs}))
        FROM ${schema.playEvents} pe
        WHERE pe.published_game_id = ${schema.publishedGames.id}
      ), 0)
      + COALESCE((
        SELECT COUNT(*) FROM ${schema.likes} l
        WHERE l.published_game_id = ${schema.publishedGames.id}
      ), 0) * 5
    )`;

    // Direct (depth-1) remix count per game's project, surfaced as remixCount.
    const remixCountExpr = sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM ${schema.remixEdges} re
      WHERE re.ancestor_project_id = ${schema.publishedGames.projectId} AND re.depth = 1
    ), 0)`;

    const conditions = [eq(schema.publishedGames.status, 'live')];
    if (opts.genre !== undefined) {
      conditions.push(sql`${schema.publishedGames.gameSpec} ->> 'genre' = ${opts.genre}`);
    }
    if (opts.tag !== undefined) {
      conditions.push(sql`${opts.tag} = ANY(${schema.publishedGames.tags})`);
    }

    const orderBy =
      opts.sort === 'popular'
        ? desc(schema.publishedGames.playCount)
        : opts.sort === 'trending'
          ? desc(trendingScore)
          : desc(schema.publishedGames.publishedAt);

    const rows = await this.db
      .select({ pg: schema.publishedGames, remixCount: remixCountExpr })
      .from(schema.publishedGames)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(opts.limit)
      .offset(opts.offset);

    return rows.map((r) => rowToHubGame(r.pg, Number(r.remixCount ?? 0)));
  }

  async incrementPlayCount(id: string): Promise<void> {
    await this.db
      .update(schema.publishedGames)
      .set({ playCount: sql`${schema.publishedGames.playCount} + 1` })
      .where(eq(schema.publishedGames.id, id));
  }

  async recordPlayEvent(input: { publishedGameId: string; userId?: string; sessionHash?: string }): Promise<void> {
    await this.db.insert(schema.playEvents).values({
      publishedGameId: input.publishedGameId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.sessionHash !== undefined ? { sessionHash: input.sessionHash } : {}),
    });
  }

  async addRemixEdge(input: { ancestorProjectId: string; descendantProjectId: string }): Promise<void> {
    // Direct depth-1 edge, plus every ancestor of the source at depth+1, so the
    // whole lineage tree is queryable. One INSERT … SELECT keeps it atomic and
    // idempotent via onConflictDoNothing on the (ancestor, descendant) PK.
    await this.db
      .insert(schema.remixEdges)
      .values({
        ancestorProjectId: input.ancestorProjectId,
        descendantProjectId: input.descendantProjectId,
        depth: 1,
      })
      .onConflictDoNothing();

    await this.db.execute(sql`
      INSERT INTO ${schema.remixEdges} (ancestor_project_id, descendant_project_id, depth)
      SELECT re.ancestor_project_id, ${input.descendantProjectId}, re.depth + 1
      FROM ${schema.remixEdges} re
      WHERE re.descendant_project_id = ${input.ancestorProjectId}
      ON CONFLICT DO NOTHING
    `);
  }

  async remixCount(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.remixEdges)
      .where(and(eq(schema.remixEdges.ancestorProjectId, projectId), eq(schema.remixEdges.depth, 1)));
    return Number(row?.n ?? 0);
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
      return rows.map((row) => rowToHubGame(row));
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
    return rows.map((row) => rowToHubGame(row));
  }

  async setEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.db
      .update(schema.publishedGames)
      .set({ embedding } as Record<string, unknown>)
      .where(eq(schema.publishedGames.id, id));
  }

  async getStats(): Promise<HubStats> {
    const [gameRow] = await this.db
      .select({
        totalPublished: sql<number>`count(*)::int`,
        totalPlays: sql<number>`COALESCE(SUM(${schema.publishedGames.playCount}), 0)::int`,
      })
      .from(schema.publishedGames)
      .where(eq(schema.publishedGames.status, 'live'));

    const [likeRow] = await this.db
      .select({ totalLikes: sql<number>`count(*)::int` })
      .from(schema.likes);

    const [commentRow] = await this.db
      .select({ totalComments: sql<number>`count(*)::int` })
      .from(schema.commentsSocial)
      .where(isNull(schema.commentsSocial.deletedAt));

    return {
      totalPublished: gameRow?.totalPublished ?? 0,
      totalPlays: gameRow?.totalPlays ?? 0,
      totalLikes: likeRow?.totalLikes ?? 0,
      totalComments: commentRow?.totalComments ?? 0,
    };
  }
}
