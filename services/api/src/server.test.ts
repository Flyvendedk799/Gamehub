import { describe, expect, it } from 'vitest';
import { HeaderAuthenticator } from './auth';
import { InMemoryProjectRepo } from './repo';
import { buildServer } from './server';

function makeApp() {
  return buildServer({ repo: new InMemoryProjectRepo(), auth: new HeaderAuthenticator() });
}
const AS_ALICE = { 'x-user-id': 'alice' };
const AS_BOB = { 'x-user-id': 'bob' };

describe('health', () => {
  it('returns ok without auth', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});

describe('auth', () => {
  it('rejects unauthenticated project access', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
  });
});

describe('projects CRUD', () => {
  it('creates, lists, gets, renames, and deletes a project', async () => {
    const app = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'My Platformer', engine: 'phaser' },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ ownerId: 'alice', name: 'My Platformer', engine: 'phaser' });
    expect(project.slug).toContain('my-platformer');

    const list = await app.inject({ method: 'GET', url: '/v1/projects', headers: AS_ALICE });
    expect(list.json().projects).toHaveLength(1);

    const got = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: AS_ALICE,
    });
    expect(got.statusCode).toBe(200);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}`,
      headers: AS_ALICE,
      payload: { name: 'Renamed' },
    });
    expect(renamed.json().name).toBe('Renamed');

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${project.id}`,
      headers: AS_ALICE,
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/v1/projects', headers: AS_ALICE });
    expect(after.json().projects).toHaveLength(0);
  });

  it('rejects an invalid engine', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { engine: 'unity' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_engine' });
  });

  it("hides another user's private project as 404, and blocks cross-user rename", async () => {
    const app = makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'secret' },
    });
    const id = created.json().id;

    const bobGet = await app.inject({ method: 'GET', url: `/v1/projects/${id}`, headers: AS_BOB });
    expect(bobGet.statusCode).toBe(404);

    const bobRename = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: AS_BOB,
      payload: { name: 'hijack' },
    });
    expect(bobRename.statusCode).toBe(404);
  });
});
