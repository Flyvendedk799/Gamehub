/**
 * Project repository. Routes depend on this interface, not on Drizzle directly,
 * so they're testable against an in-memory impl. A Drizzle-backed impl over
 * @playforge/db lands when we wire Postgres in CI/dev.
 */
export type Engine = 'three' | 'phaser';
export type Visibility = 'private' | 'unlisted' | 'public';

export interface Project {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  engine: Engine | null;
  visibility: Visibility;
  currentSnapshotId: string | null;
  remixOfProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  ownerId: string;
  name?: string;
  engine?: Engine;
  visibility?: Visibility;
  remixOfProjectId?: string;
}

export interface ProjectRepo {
  create(input: CreateProjectInput): Promise<Project>;
  get(id: string): Promise<Project | null>;
  listByOwner(ownerId: string): Promise<Project[]>;
  rename(id: string, ownerId: string, name: string): Promise<Project | null>;
  softDelete(id: string, ownerId: string): Promise<boolean>;
}

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'game'}-${id.slice(0, 8)}`;
}

/** In-memory ProjectRepo for tests and local dev without Postgres. */
export class InMemoryProjectRepo implements ProjectRepo {
  private readonly byId = new Map<string, Project>();
  private seq = 0;

  constructor(private readonly now: () => string = () => '2026-01-01T00:00:00.000Z') {}

  private nextId(): string {
    this.seq += 1;
    return `proj_${this.seq.toString().padStart(8, '0')}`;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const id = this.nextId();
    const ts = this.now();
    const name = input.name ?? 'Untitled game';
    const project: Project = {
      id,
      ownerId: input.ownerId,
      slug: slugify(name, id),
      name,
      engine: input.engine ?? null,
      visibility: input.visibility ?? 'private',
      currentSnapshotId: null,
      remixOfProjectId: input.remixOfProjectId ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.byId.set(id, project);
    return project;
  }

  async get(id: string): Promise<Project | null> {
    return this.byId.get(id) ?? null;
  }

  async listByOwner(ownerId: string): Promise<Project[]> {
    return [...this.byId.values()]
      .filter((p) => p.ownerId === ownerId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async rename(id: string, ownerId: string, name: string): Promise<Project | null> {
    const p = this.byId.get(id);
    if (!p || p.ownerId !== ownerId) return null;
    const updated: Project = { ...p, name, updatedAt: this.now() };
    this.byId.set(id, updated);
    return updated;
  }

  async softDelete(id: string, ownerId: string): Promise<boolean> {
    const p = this.byId.get(id);
    if (!p || p.ownerId !== ownerId) return false;
    this.byId.delete(id);
    return true;
  }
}
