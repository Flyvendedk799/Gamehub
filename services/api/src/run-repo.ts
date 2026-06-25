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

/** Active-generation timing recorded once the agent loop settles. */
export interface RunRuntimeUpdate {
  startedAt: Date;
  finishedAt: Date;
  runtimeMs: number;
}

/** Per-run token usage seeded into the in-memory repo for aggregation tests. */
export interface RunUsageUpdate {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Aggregated social-outro metrics for a project (docs/SOCIAL_OUTRO_PLAN.md).
 * Summed over `completed` runs that produced a snapshot. `totalTokens` is
 * derived (input + output) by the route, not stored here.
 */
export interface ProjectSocialMetrics {
  aiRuntimeMs: number;
  promptLoops: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
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
  /**
   * The project's most recent run, returned ONLY if it is still non-terminal
   * (queued/running/paused) — so the web app can re-attach to a live run after a
   * page reload. Returns null when the latest run is completed/failed/canceled
   * (so a stale earlier paused run is never surfaced over a newer finished one).
   */
  getActiveByProject(projectId: string): Promise<Run | null>;
  /** Aggregate run stats for build-health dashboard. */
  getStats(): Promise<RunStats>;
  /** Persist the active-generation timing for a run (social-outro AI runtime). */
  setRuntime(id: string, update: RunRuntimeUpdate): Promise<void>;
  /** Aggregate social-outro metrics over a project's completed snapshot runs. */
  getProjectSocialMetrics(projectId: string): Promise<ProjectSocialMetrics>;
  /** Mark a run as paused with a continuation payload (used in tests and Drizzle impl). */
  setPaused?(id: string, continuation: unknown, snapshotManifestKey?: string): Promise<void>;
  /** Seed per-run token usage (in-memory only; the real path writes via finalizeRun). */
  setUsage?(id: string, usage: RunUsageUpdate): Promise<void>;
}

export class InMemoryRunRepo implements RunRepo {
  private readonly byId = new Map<string, Run>();
  /** Side maps for the social-outro aggregation (kept off the public Run shape). */
  private readonly runtimeById = new Map<string, number>();
  private readonly usageById = new Map<string, RunUsageUpdate>();
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

  async getActiveByProject(projectId: string): Promise<Run | null> {
    // The most recently created run for this project (Map preserves insertion =
    // creation order, so the last match wins — robust to equal ISO timestamps).
    let latest: Run | undefined;
    for (const r of this.byId.values()) {
      if (r.projectId === projectId) latest = r;
    }
    if (!latest) return null;
    const active =
      latest.status === 'queued' || latest.status === 'running' || latest.status === 'paused';
    return active ? latest : null;
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

  async setRuntime(id: string, update: RunRuntimeUpdate): Promise<void> {
    if (this.byId.has(id)) this.runtimeById.set(id, update.runtimeMs);
  }

  async setUsage(id: string, usage: RunUsageUpdate): Promise<void> {
    if (this.byId.has(id)) this.usageById.set(id, { ...usage });
  }

  async getProjectSocialMetrics(projectId: string): Promise<ProjectSocialMetrics> {
    const metrics: ProjectSocialMetrics = {
      aiRuntimeMs: 0,
      promptLoops: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    for (const run of this.byId.values()) {
      // Mirror the Drizzle filter: completed runs that produced a snapshot.
      if (
        run.projectId !== projectId ||
        run.status !== 'completed' ||
        run.snapshotManifestKey === undefined
      ) {
        continue;
      }
      metrics.promptLoops += 1;
      metrics.aiRuntimeMs += this.runtimeById.get(run.id) ?? 0;
      const usage = this.usageById.get(run.id);
      if (usage) {
        metrics.inputTokens += usage.inputTokens;
        metrics.outputTokens += usage.outputTokens;
        metrics.cachedInputTokens += usage.cachedInputTokens;
        metrics.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      }
    }
    return metrics;
  }
}
