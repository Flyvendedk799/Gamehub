import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, runChannel } from '@playforge/bus';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { HeaderAuthenticator } from './auth';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import { buildServer, type EnqueueFn } from './server';

function makeApp(overrides?: {
  bus?: InstanceType<typeof InMemoryEventBus>;
  runRepo?: InstanceType<typeof InMemoryRunRepo>;
  enqueue?: EnqueueFn;
  store?: SnapshotStore;
}) {
  return buildServer({
    repo: new InMemoryProjectRepo(),
    auth: new HeaderAuthenticator(),
    bus: overrides?.bus ?? new InMemoryEventBus(),
    runRepo: overrides?.runRepo ?? new InMemoryRunRepo(),
    enqueue: overrides?.enqueue ?? (async () => {}),
    ...(overrides?.store !== undefined ? { store: overrides.store } : {}),
  });
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

describe('generation enqueue', () => {
  it('creates a run and calls enqueue, returning 202 + runId', async () => {
    const enqueued: Array<{ runId: string; prompt: string }> = [];
    const enqueue: EnqueueFn = async (input) => {
      enqueued.push({ runId: input.runId, prompt: input.prompt });
    };

    const app = makeApp({ enqueue });

    // Create a project first
    const proj = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'Red Square', engine: 'phaser' },
    });
    const projectId: string = proj.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'a red square that moves' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    expect(runId).toMatch(/^run_/);
    // Enqueue may be called async (fire-and-forget), but our fake is sync
    expect(enqueued[0]).toMatchObject({ runId, prompt: 'a red square that moves' });
  });

  it('rejects an empty prompt', async () => {
    const app = makeApp();
    const proj = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'test' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${proj.json().id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'prompt_required' });
  });

  it("rejects generate on another user's project", async () => {
    const app = makeApp();
    const proj = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'secret' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${proj.json().id}/generate`,
      headers: AS_BOB,
      payload: { prompt: 'attack' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('SSE event relay', () => {
  it('streams pre-published run events, ending on run_complete', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();

    // Create a run owned by alice
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    // Pre-publish events (InMemoryEventBus will replay these synchronously on subscribe)
    await bus.publish(runChannel(run.id), { type: 'text_delta', text: 'building...' });
    await bus.publish(runChannel(run.id), { type: 'tool_call', name: 'create_file' });
    await bus.publish(runChannel(run.id), { type: 'run_complete' });

    const app = makeApp({ bus, runRepo });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_ALICE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('"type":"text_delta"');
    expect(res.body).toContain('"type":"tool_call"');
    expect(res.body).toContain('"type":"run_complete"');

    // Each event is a separate SSE data line
    const lines = res.body.split('\n').filter((l) => l.startsWith('data:'));
    expect(lines).toHaveLength(3);
  });

  it('also ends the stream on run_error', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    await bus.publish(runChannel(run.id), { type: 'run_error', error: 'out of credits' });

    const app = makeApp({ bus, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"run_error"');
  });

  it("rejects streaming another user's run", async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const app = makeApp({ runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_BOB,
    });
    expect(res.statusCode).toBe(404);
  });

  it('injects previewUrl into run_complete event', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    await bus.publish(runChannel(run.id), { type: 'run_complete' });

    const app = makeApp({ bus, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_ALICE,
    });

    expect(res.statusCode).toBe(200);
    const dataLine = res.body.split('\n').find((l) => l.startsWith('data:')) ?? '';
    const event = JSON.parse(dataLine.replace('data: ', '')) as { type: string; previewUrl?: string };
    expect(event.type).toBe('run_complete');
    expect(event.previewUrl).toBe(`/v1/runs/${run.id}/preview/`);
  });

  it('accepts ?userId= query param in lieu of x-user-id header', async () => {
    const runRepo = new InMemoryRunRepo();
    const bus = new InMemoryEventBus();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await bus.publish(runChannel(run.id), { type: 'run_complete' });

    const app = makeApp({ bus, runRepo });
    // No header — userId only via query param
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream?userId=alice`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"run_complete"');
  });
});

describe('preview route', () => {
  it('serves index.html from a run snapshot', async () => {
    const blobStore = new InMemoryBlobStore();
    const store = new SnapshotStore(blobStore);
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const html = '<html>game</html>';
    const { manifestKey } = await store.write([
      { path: 'index.html', bytes: Buffer.from(html) },
    ]);
    await runRepo.setSnapshot(run.id, manifestKey);

    const app = makeApp({ store, runRepo });
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/preview/` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toBe(html);
  });

  it('serves sub-assets from a run snapshot', async () => {
    const blobStore = new InMemoryBlobStore();
    const store = new SnapshotStore(blobStore);
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const { manifestKey } = await store.write([
      { path: 'index.html', bytes: Buffer.from('<html/>') },
      { path: 'assets/audio/sound.wav', bytes: Buffer.from('wavdata') },
    ]);
    await runRepo.setSnapshot(run.id, manifestKey);

    const app = makeApp({ store, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/preview/assets/audio/sound.wav`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
  });

  it('returns 404 when run has no snapshot yet', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const app = makeApp({ store, runRepo });
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/preview/` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('not_found');
  });

  it('returns 503 when store is not configured', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const app = makeApp({ runRepo }); // no store
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/preview/` });
    expect(res.statusCode).toBe(503);
  });
});
