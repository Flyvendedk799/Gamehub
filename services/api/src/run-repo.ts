/**
 * Run repository. Tracks in-flight and completed generation runs. Routes
 * depend on this interface so they're testable without Postgres.
 * A Drizzle-backed impl over @playforge/db lands when Postgres is wired.
 */

export interface Run {
  id: string;
  projectId: string;
  userId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  snapshotManifestKey?: string;
}

export interface CreateRunInput {
  projectId: string;
  userId: string;
}

export interface RunRepo {
  create(input: CreateRunInput): Promise<Run>;
  get(id: string): Promise<Run | null>;
  updateStatus(id: string, status: Run['status']): Promise<void>;
  setSnapshot(id: string, manifestKey: string): Promise<void>;
  /** Count queued/running runs for a user (for concurrent run cap). */
  countActiveByUser(userId: string): Promise<number>;
  /** Load the continuation payload (jsonb) from a paused run, if any. */
  getPausedContinuation(projectId: string): Promise<{ continuation: unknown; snapshotManifestKey: string | null } | null>;
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

  async countActiveByUser(userId: string): Promise<number> {
    return [...this.byId.values()].filter(
      (r) => r.userId === userId && (r.status === 'queued' || r.status === 'running'),
    ).length;
  }

  async getPausedContinuation(_projectId: string): Promise<{ continuation: unknown; snapshotManifestKey: string | null } | null> {
    return null; // InMemory: no paused runs
  }
}
