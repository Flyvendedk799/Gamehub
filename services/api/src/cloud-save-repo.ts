/**
 * Cloud-save repository (Engine Evolution P10b — cross-device game saves).
 *
 * A cloud save is scoped to (authenticated user, project, key). Routes depend on
 * this interface, not on Drizzle directly, so they're testable against the
 * in-memory impl. A logged-in user reads/writes ONLY their own saves; there is
 * NO ownership requirement on the project (any logged-in user may save progress
 * for any game they play). The Drizzle-backed impl lives in drizzle-repos.ts.
 */
export interface CloudSaveRepo {
  /** Read one save for (user, project, key). Null when no row exists. */
  get(userId: string, projectId: string, key: string): Promise<unknown | null>;
  /** Upsert one save for (user, project, key) on the composite PK. */
  set(userId: string, projectId: string, key: string, value: unknown): Promise<void>;
  /** Count distinct save keys for (user, project) — used to cap a hostile game's
   *  unbounded key creation (each row is ≤100KB; bound the count too). */
  countKeys(userId: string, projectId: string): Promise<number>;
  /** Delete one save for (user, project, key). No-op when absent. */
  clearKey(userId: string, projectId: string, key: string): Promise<void>;
  /** Delete ALL saves for (user, project). */
  clearProject(userId: string, projectId: string): Promise<void>;
}

/** Composite-key string for the in-memory map. */
function mapKey(userId: string, projectId: string, key: string): string {
  return JSON.stringify([userId, projectId, key]);
}

/** In-memory CloudSaveRepo for tests and local dev without Postgres. */
export class InMemoryCloudSaveRepo implements CloudSaveRepo {
  private readonly byKey = new Map<string, unknown>();

  async get(userId: string, projectId: string, key: string): Promise<unknown | null> {
    const k = mapKey(userId, projectId, key);
    return this.byKey.has(k) ? (this.byKey.get(k) ?? null) : null;
  }

  async set(userId: string, projectId: string, key: string, value: unknown): Promise<void> {
    this.byKey.set(mapKey(userId, projectId, key), value);
  }

  async countKeys(userId: string, projectId: string): Promise<number> {
    const prefix = JSON.stringify([userId, projectId]).slice(0, -1);
    let n = 0;
    for (const k of this.byKey.keys()) if (k.startsWith(prefix)) n += 1;
    return n;
  }

  async clearKey(userId: string, projectId: string, key: string): Promise<void> {
    this.byKey.delete(mapKey(userId, projectId, key));
  }

  async clearProject(userId: string, projectId: string): Promise<void> {
    const prefix = JSON.stringify([userId, projectId]).slice(0, -1); // drop trailing ']'
    for (const k of this.byKey.keys()) {
      // Keys are `["user","project","key"]`; match on the (user, project) prefix.
      if (k.startsWith(prefix)) this.byKey.delete(k);
    }
  }
}
