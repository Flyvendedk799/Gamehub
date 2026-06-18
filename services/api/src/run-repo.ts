/**
 * Run repository. Tracks in-flight and completed generation runs. Routes
 * depend on this interface so they're testable without Postgres.
 * A Drizzle-backed impl over @playforge/db lands when Postgres is wired.
 */

export interface Run {
  id: string;
  projectId: string;
  userId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'canceled';
  createdAt: string;
  snapshotManifestKey?: string;
  /** Populated when status === 'paused'. Carries the continuation payload. */
  continuation?: unknown;
}

export interface CreateRunInput {
  projectId: string;
  userId: string;
}

export interface RunStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
  successRate: number;
}

export interface RunRepo {
  create(input: CreateRunInput): Promise<Run>;
  get(id: string): Promise<Run | null>;
  updateStatus(id: string, status: Run['status']): Promise<void>;
  setSnapshot(id: string, manifestKey: string): Promise<void>;
  /** Count queued/running runs for a user (for concurrent run cap). */
  countActiveByUser(userId: string): Promise<number>;
  /** Load the continuation payload (jsonb) from a paused run, if any. */
  getPausedContinuation(
    projectId: string,
  ): Promise<{ continuation: unknown; snapshotManifestKey: string | null } | null>;
  /** Aggregate run stats for build-health dashboard. */
  getStats(): Promise<RunStats>;
  /** Mark a run as paused with a continuation payload (used in tests and Drizzle impl). */
  setPaused?(id: string, continuation: unknown, snapshotManifestKey?: string): Promise<void>;
}

export class InMemoryRunRepo implements RunRepo {
  private readonly byId = new Map<string, Run>();
  private seq = 0;

  async create(input: CreateRunInput): Promise<Run> {
    this.seq += 1;
    const id = `run_${this.seq.toString().padStart(8, '0')}`;
    const run: Run = { id, ...input, status: 'queued', createdAt: new Date().toISOString() };
    this.byId.set(id, run);
    return run;
  }

  async get(id: string): Promise<Run | null> {
    return this.byId.get(id) ?? null;
  }

  async updateStatus(id: string, status: Run['status']): Promise<void> {
    const existing = this.byId.get(id);
    if (existing) this.byId.set(id, { ...existing, status });
  }

  async setSnapshot(id: string, manifestKey: string): Promise<void> {
    const existing = this.byId.get(id);
    if (existing) this.byId.set(id, { ...existing, snapshotManifestKey: manifestKey });
  }

  async setPaused(id: string, continuation: unknown, snapshotManifestKey?: string): Promise<void> {
    const existing = this.byId.get(id);
    if (existing) {
      this.byId.set(id, {
        ...existing,
        status: 'paused',
        continuation,
        ...(snapshotManifestKey !== undefined ? { snapshotManifestKey } : {}),
      });
    }
  }

  async countActiveByUser(userId: string): Promise<number> {
    return [...this.byId.values()].filter(
      (r) => r.userId === userId && (r.status === 'queued' || r.status === 'running'),
    ).length;
  }

  async getPausedContinuation(
    projectId: string,
  ): Promise<{ continuation: unknown; snapshotManifestKey: string | null } | null> {
    // Find the most recently created paused run for this project.
    const paused = [...this.byId.values()]
      .filter(
        (r) => r.projectId === projectId && r.status === 'paused' && r.continuation !== undefined,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!paused) return null;
    return {
      continuation: paused.continuation,
      snapshotManifestKey: paused.snapshotManifestKey ?? null,
    };
  }

  async getStats(): Promise<RunStats> {
    const runs = [...this.byId.values()];
    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'completed').length;
    const failed = runs.filter((r) => r.status === 'failed').length;
    const active = runs.filter((r) => r.status === 'queued' || r.status === 'running').length;
    const successRate = total > 0 ? completed / total : 0;
    return { total, completed, failed, active, successRate };
  }
}
