import { randomUUID } from 'node:crypto';
import type { GameSpec } from '@playforge/shared';

export type SnapshotEngine = 'three' | 'phaser' | 'canvas2d';

export interface SnapshotEntry {
  id: string;
  projectId: string;
  parentId: string | null;
  seq: number;
  type: 'initial' | 'edit' | 'fork' | 'remix' | 'revert';
  prompt: string | null;
  engine: SnapshotEngine | null;
  gameSpec: GameSpec | null;
  tweakSchema: Record<string, unknown> | null;
  filesManifestKey: string;
  filesHash: string;
  createdAt: string;
}

/**
 * Fields for appending a new snapshot row. `seq` + `id` + `createdAt` are
 * allocated by the implementation (seq under a per-project lock in Postgres).
 * Used by the manual file-edit route, which writes a new content-addressed
 * manifest and records it as an `edit` version so the existing History/Restore
 * UI is the undo path for hand-edits.
 */
export interface AppendSnapshotInput {
  projectId: string;
  parentId?: string | null;
  type: SnapshotEntry['type'];
  prompt?: string | null;
  engine?: SnapshotEngine | null;
  gameSpec?: GameSpec | null;
  tweakSchema?: Record<string, unknown> | null;
  filesManifestKey: string;
  filesHash: string;
}

export interface SnapshotRepo {
  listByProject(projectId: string): Promise<SnapshotEntry[]>;
  getById(snapshotId: string): Promise<SnapshotEntry | null>;
  /** Append a new snapshot version (allocates the next per-project seq). */
  append(input: AppendSnapshotInput): Promise<SnapshotEntry>;
}

export class InMemorySnapshotRepo implements SnapshotRepo {
  private readonly byProject = new Map<string, SnapshotEntry[]>();

  push(
    entry: Omit<SnapshotEntry, 'tweakSchema'> & { tweakSchema?: Record<string, unknown> | null },
  ): void {
    const list = this.byProject.get(entry.projectId) ?? [];
    list.push({ ...entry, tweakSchema: entry.tweakSchema ?? null });
    this.byProject.set(entry.projectId, list);
  }

  async listByProject(projectId: string): Promise<SnapshotEntry[]> {
    const list = this.byProject.get(projectId) ?? [];
    return [...list].sort((a, b) => b.seq - a.seq);
  }

  async getById(snapshotId: string): Promise<SnapshotEntry | null> {
    for (const list of this.byProject.values()) {
      const found = list.find((e) => e.id === snapshotId);
      if (found) return found;
    }
    return null;
  }

  async append(input: AppendSnapshotInput): Promise<SnapshotEntry> {
    const list = this.byProject.get(input.projectId) ?? [];
    const nextSeq = list.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
    const entry: SnapshotEntry = {
      id: randomUUID(),
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      seq: nextSeq,
      type: input.type,
      prompt: input.prompt ?? null,
      engine: input.engine ?? null,
      gameSpec: input.gameSpec ?? null,
      tweakSchema: input.tweakSchema ?? null,
      filesManifestKey: input.filesManifestKey,
      filesHash: input.filesHash,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    this.byProject.set(input.projectId, list);
    return entry;
  }
}
