import type { GameSpec } from '@playforge/shared';

export type SnapshotEngine = 'three' | 'phaser';

export interface SnapshotEntry {
  id: string;
  projectId: string;
  parentId: string | null;
  seq: number;
  type: 'initial' | 'edit' | 'fork' | 'remix' | 'revert';
  prompt: string | null;
  engine: SnapshotEngine | null;
  gameSpec: GameSpec | null;
  filesManifestKey: string;
  filesHash: string;
  createdAt: string;
}

export interface SnapshotRepo {
  listByProject(projectId: string): Promise<SnapshotEntry[]>;
  getById(snapshotId: string): Promise<SnapshotEntry | null>;
}

export class InMemorySnapshotRepo implements SnapshotRepo {
  private readonly byProject = new Map<string, SnapshotEntry[]>();

  push(entry: SnapshotEntry): void {
    const list = this.byProject.get(entry.projectId) ?? [];
    list.push(entry);
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
}
