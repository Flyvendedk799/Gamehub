import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, runChannel } from '@playforge/bus';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { HeaderAuthenticator } from './auth';
import { InMemoryHubRepo } from './hub-repo';
import { InMemoryPublishRepo } from './publish-repo';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import { buildServer, decideAffordability, type EnqueueFn, type ServerDeps } from './server';

function makeApp(overrides?: {
  bus?: InstanceType<typeof InMemoryEventBus>;
  runRepo?: InstanceType<typeof InMemoryRunRepo>;
  repo?: InstanceType<typeof InMemoryProjectRepo>;
  enqueue?: EnqueueFn;
  store?: SnapshotStore;
  publishRepo?: InMemoryPublishRepo;
  hubRepo?: InMemoryHubRepo;
  adminToken?: string;
}) {
  return buildServer({
    repo: overrides?.repo ?? new InMemoryProjectRepo(),
    auth: new HeaderAuthenticator(),
    bus: overrides?.bus ?? new InMemoryEventBus(),
    runRepo: overrides?.runRepo ?? new InMemoryRunRepo(),
    enqueue: overrides?.enqueue ?? (async () => {}),
    ...(overrides?.store !== undefined ? { store: overrides.store } : {}),
    ...(overrides?.publishRepo !== undefined ? { publishRepo: overrides.publishRepo } : {}),
    ...(overrides?.hubRepo !== undefined ? { hubRepo: overrides.hubRepo } : {}),
    ...(overrides?.adminToken !== undefined ? { adminToken: overrides.adminToken } : {}),
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

describe('admin gate fails closed', () => {
  it('returns 503 admin_disabled on /v1/admin/metrics when no ADMIN_TOKEN is configured', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/v1/admin/metrics' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'admin_disabled' });
  });

  it('returns 503 admin_disabled on moderation when no ADMIN_TOKEN is configured', async () => {
    const app = makeApp({ publishRepo: new InMemoryPublishRepo() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/games/some-slug/moderate',
      payload: { status: 'removed_by_mod' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'admin_disabled' });
  });

  it('rejects a wrong admin token with 403 and accepts the right one', async () => {
    const app = makeApp({ adminToken: 'sekret' });
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { 'x-admin-token': 'wrong' },
    });
    expect(bad.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/admin/metrics',
      headers: { 'x-admin-token': 'sekret' },
    });
    expect(ok.statusCode).toBe(200);
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

  it('rejects an oversized prompt (#31 ingress cap)', async () => {
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
      payload: { prompt: 'x'.repeat(8001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'prompt_too_long' });
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

describe('publish + play routes', () => {
  it('returns 409 when project has no snapshot', async () => {
    const repo = new InMemoryProjectRepo();
    const proj = await repo.create({ ownerId: 'alice', name: 'My Game', engine: 'phaser' });
    const store = new SnapshotStore(new InMemoryBlobStore());
    const publishRepo = new InMemoryPublishRepo();

    const app = makeApp({ repo, store, publishRepo });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${proj.id}/publish`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('no_snapshot');
  });

  it('returns 503 when store/publishRepo not configured', async () => {
    const repo = new InMemoryProjectRepo();
    const proj = await repo.create({ ownerId: 'alice', name: 'My Game', engine: 'phaser' });

    const app = makeApp({ repo }); // no store or publishRepo
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${proj.id}/publish`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 404 for unknown slug on play route', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const publishRepo = new InMemoryPublishRepo();

    const app = makeApp({ store, publishRepo });
    const res = await app.inject({ method: 'GET', url: '/v1/play/missing-slug' });
    expect(res.statusCode).toBe(404);
  });

  it('get publish-info returns null when not published', async () => {
    const repo = new InMemoryProjectRepo();
    const proj = await repo.create({ ownerId: 'alice', name: 'Test', engine: 'phaser' });
    const publishRepo = new InMemoryPublishRepo();

    const app = makeApp({ repo, publishRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${proj.id}/publish-info`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { published: null }).published).toBeNull();
  });
});

describe('hub routes', () => {
  it('GET /v1/hub returns 503 when hubRepo not configured', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/v1/hub' });
    expect(res.statusCode).toBe(503);
  });

  it('GET /v1/hub returns empty feed from hubRepo', async () => {
    const hubRepo = new InMemoryHubRepo();
    const app = makeApp({ hubRepo });
    const res = await app.inject({ method: 'GET', url: '/v1/hub' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { games: unknown[] }).games).toEqual([]);
  });

  it('GET /v1/hub/games/:slug returns 404 for unknown slug', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    const app = makeApp({ hubRepo, publishRepo });
    const res = await app.inject({ method: 'GET', url: '/v1/hub/games/unknown' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/hub/games/:slug/comments returns empty list', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    // Seed a published game so the route can find it
    await publishRepo.upsert({ projectId: 'p1', publishSlug: 'my-game', title: 'My Game', bundleKey: 'k' });

    const app = makeApp({ hubRepo, publishRepo });
    const res = await app.inject({ method: 'GET', url: '/v1/hub/games/my-game/comments' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { comments: unknown[] }).comments).toEqual([]);
  });

  it('POST /v1/hub/games/:slug/like returns 404 for unknown slug', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    const app = makeApp({ hubRepo, publishRepo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/nope/like',
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(404);
  });

  it('remix returns 404 for unknown slug', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    const app = makeApp({ hubRepo, publishRepo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/nope/remix',
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(404);
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

describe('moderation', () => {
  it('moderator can take down a published game', async () => {
    const publishRepo = new InMemoryPublishRepo();
    const game = await publishRepo.upsert({
      projectId: 'proj_mod',
      publishSlug: 'test-mod-game',
      title: 'Mod Test',
      bundleKey: 'blobs/abc123',
    });
    expect(game.status).toBe('live');

    const app = buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
      publishRepo,
      adminToken: 'secret-admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/games/test-mod-game/moderate',
      headers: { 'x-admin-token': 'secret-admin' },
      payload: { status: 'removed_by_mod' },
    });
    expect(res.statusCode).toBe(200);

    const taken = await publishRepo.getBySlug('test-mod-game');
    expect(taken?.status).toBe('removed_by_mod');
  });

  it('rejects moderation without admin token', async () => {
    const publishRepo = new InMemoryPublishRepo();
    await publishRepo.upsert({
      projectId: 'proj_mod2',
      publishSlug: 'test-mod-game2',
      title: 'Mod Test 2',
      bundleKey: 'blobs/def',
    });

    const app = buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
      publishRepo,
      adminToken: 'secret-admin',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/games/test-mod-game2/moderate',
      headers: { 'x-admin-token': 'wrong-token' },
      payload: { status: 'removed_by_mod' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('resume / continuation', () => {
  it('resumes a paused run on next prompt', async () => {
    const repo = new InMemoryProjectRepo();
    const runRepo = new InMemoryRunRepo();

    // Create a project owned by alice.
    const project = await repo.create({ ownerId: 'alice', name: 'Paused Game', engine: 'phaser' });

    // Simulate a prior run that was paused with a continuation payload.
    const priorRun = await runRepo.create({ projectId: project.id, userId: 'alice' });
    const pausedContinuation = { todos: null, decisionRecap: 'half built', fsState: {}, originalUserPrompt: 'build a platformer' };
    await runRepo.setPaused(priorRun.id, pausedContinuation, 'manifest-key-abc');

    // Capture what is passed to enqueue on the second generate call.
    const enqueued: Array<Parameters<EnqueueFn>[0]> = [];
    const enqueue: EnqueueFn = async (input) => {
      enqueued.push(input);
    };

    const app = makeApp({ repo, runRepo, enqueue });

    // Second generate call — should pick up the paused continuation.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'continue building' },
    });
    expect(res.statusCode).toBe(202);

    // The enqueue call should carry the continuation payload from the paused run.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      continuation: pausedContinuation,
      parentManifestKey: 'manifest-key-abc',
    });
  });
});

describe('concurrent run cap', () => {
  it('blocks generation when concurrent run limit is reached', async () => {
    const runRepo = new InMemoryRunRepo();
    const repo = new InMemoryProjectRepo();

    const project = await repo.create({ ownerId: 'alice', name: 'Cap Test', engine: 'phaser' });
    // Pre-create a run in queued state to simulate an active run.
    await runRepo.create({ projectId: project.id, userId: 'alice' });

    const app = buildServer({
      repo,
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo,
      enqueue: async () => {},
      maxConcurrentRunsPerUser: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'make a platformer' },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: string }).error).toBe('concurrent_run_limit');
  });

  it('allows generation when under the concurrent limit', async () => {
    const runRepo = new InMemoryRunRepo();
    const repo = new InMemoryProjectRepo();

    const project = await repo.create({ ownerId: 'alice', name: 'Cap OK', engine: 'phaser' });

    const app = buildServer({
      repo,
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo,
      enqueue: async () => {},
      maxConcurrentRunsPerUser: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'make a platformer' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('returns 503 on register when authDb is not configured', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'x@example.com', password: 'pass1234', handle: 'xuser' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 503 on login when authDb is not configured', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'x@example.com', password: 'pass1234' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('decideAffordability (pure)', () => {
  it('is affordable exactly at the run cost', () => {
    expect(decideAffordability(10, 10)).toEqual({ ok: true, balance: 10, required: 10 });
  });
  it('is not affordable just below the run cost', () => {
    expect(decideAffordability(9, 10)).toEqual({ ok: false, balance: 9, required: 10 });
  });
  it('defaults required to CREDITS_PER_RUN (10)', () => {
    expect(decideAffordability(100)).toMatchObject({ ok: true, required: 10 });
    expect(decideAffordability(5)).toMatchObject({ ok: false, required: 10 });
  });
});

/**
 * Minimal drizzle-Db stub for the credit-reservation transaction. Records the
 * rows the route inserts and answers the balance SUM from a seeded starting
 * balance plus any inserted deltas — enough to drive the 402 path and the
 * idempotent-reservation no-op without a live Postgres.
 */
function makeFakeAuthDb(startingBalance: number): {
  authDb: ServerDeps['authDb'];
  inserted: Array<{ reason: string; delta: number; runId?: string }>;
} {
  const inserted: Array<{ reason: string; delta: number; runId?: string }> = [];
  const balance = () => startingBalance + inserted.reduce((n, r) => n + r.delta, 0);

  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: async () => [{ bal: balance() }],
      }),
    }),
    insert: () => ({
      values: (row: { reason: string; delta: number; runId?: string }) => ({
        onConflictDoNothing: async () => {
          // Idempotent on (run_id) where reason='reservation': drop a duplicate.
          const dup = inserted.some((r) => r.reason === row.reason && r.runId === row.runId);
          if (!dup) inserted.push(row);
        },
      }),
    }),
  };

  const authDb = {
    transaction: async (fn: (t: typeof tx) => Promise<void>) => {
      await fn(tx);
    },
  } as unknown as ServerDeps['authDb'];

  return { authDb, inserted };
}

describe('credit reservation (#6)', () => {
  async function makeProjectAndGenerate(authDb: ServerDeps['authDb']) {
    const repo = new InMemoryProjectRepo();
    const runRepo = new InMemoryRunRepo();
    const project = await repo.create({ ownerId: 'alice', name: 'Credit Test', engine: 'phaser' });
    const enqueued: string[] = [];
    const app = buildServer({
      repo,
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo,
      enqueue: async (input) => { enqueued.push(input.runId); },
      ...(authDb !== undefined ? { authDb } : {}),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'make a game' },
    });
    return { res, runRepo, enqueued };
  }

  it('reserves the run cost and enqueues when the balance is sufficient', async () => {
    const { authDb, inserted } = makeFakeAuthDb(100);
    const { res, enqueued } = await makeProjectAndGenerate(authDb);
    expect(res.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
    // Exactly one negative reservation row was written for this run.
    const reservations = inserted.filter((r) => r.reason === 'reservation');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ delta: -10, runId: enqueued[0] });
  });

  it('returns 402 + marks the run failed when the balance is too low', async () => {
    const { authDb } = makeFakeAuthDb(5);
    const { res, runRepo, enqueued } = await makeProjectAndGenerate(authDb);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits', balance: 5, required: 10 });
    // No enqueue on the insufficient path.
    expect(enqueued).toHaveLength(0);
    // The just-created run was marked failed (not left dangling as 'queued').
    const stats = await runRepo.getStats();
    expect(stats.failed).toBe(1);
    expect(stats.active).toBe(0);
  });

  it('reservation insert is idempotent — a duplicate runId is a no-op', async () => {
    const { authDb, inserted } = makeFakeAuthDb(100);
    // First reservation.
    await makeProjectAndGenerate(authDb);
    const firstRunId = inserted.find((r) => r.reason === 'reservation')?.runId;
    expect(firstRunId).toBeDefined();
    // Re-running onConflictDoNothing with the same runId must not add a second row.
    await authDb!.transaction(async (tx) => {
      await (tx as unknown as {
        insert: () => { values: (r: unknown) => { onConflictDoNothing: () => Promise<void> } };
      })
        .insert()
        .values({ reason: 'reservation', delta: -10, runId: firstRunId })
        .onConflictDoNothing();
    });
    expect(inserted.filter((r) => r.reason === 'reservation')).toHaveLength(1);
  });

  it('skips reservation entirely when authDb is undefined (tests/dev)', async () => {
    const { res, enqueued } = await makeProjectAndGenerate(undefined);
    expect(res.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
  });
});
