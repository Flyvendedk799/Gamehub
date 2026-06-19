import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject, getProject } from '../api';
import type { Project } from '../types';

const project: Project = {
  id: 'project_123',
  name: 'Red Square',
  engine: 'phaser',
  createdAt: '2026-06-19T08:00:00.000Z',
  updatedAt: '2026-06-19T08:00:00.000Z',
};

function stubJsonResponse(body: unknown): void {
  const fetchStub: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  vi.stubGlobal('fetch', fetchStub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project API client', () => {
  it('wraps the direct project response returned by the API on create', async () => {
    stubJsonResponse(project);

    await expect(createProject('Red Square', 'phaser')).resolves.toEqual({ project });
  });

  it('wraps the direct project response returned by the API on get', async () => {
    stubJsonResponse(project);

    await expect(getProject(project.id)).resolves.toEqual({ project });
  });

  it('keeps an already-wrapped project response intact', async () => {
    stubJsonResponse({ project });

    await expect(createProject('Red Square', 'phaser')).resolves.toEqual({ project });
  });
});
