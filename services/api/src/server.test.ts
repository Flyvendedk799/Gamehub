import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, runChannel } from '@playforge/bus';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { HeaderAuthenticator } from './auth';
import { InMemoryHubRepo } from './hub-repo';
import { InMemoryPublishRepo } from './publish-repo';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import {
  attachSseHeartbeat,
  buildServer,
  decideAffordability,
  SSE_HEARTBEAT_FRAME,
  type EnqueueFn,
  type ServerDeps,
} from './server';

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

  it('a terminal stream does NOT emit a heartbeat frame (it finishes first)', async () => {
    // The InMemoryEventBus replays run_complete synchronously, so finish() fires
    // and clears the heartbeat before any 20s tick — the body has no `: ping`.
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
    expect(res.body).not.toContain(': ping');
  });
});

describe('SSE heartbeat + max-duration cap (4.2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes a `: ping` comment frame every heartbeat interval', () => {
    const writes: string[] = [];
    const stop = attachSseHeartbeat((c) => writes.push(c), () => {}, {
      heartbeatMs: 1_000,
      maxMs: 60_000,
    });

    expect(writes).toHaveLength(0); // nothing yet
    vi.advanceTimersByTime(1_000);
    expect(writes).toEqual([SSE_HEARTBEAT_FRAME]);
    vi.advanceTimersByTime(2_000);
    expect(writes).toEqual([SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME]);
    stop();
  });

  it('stop() clears the interval — no further frames after close', () => {
    const writes: string[] = [];
    const stop = attachSseHeartbeat((c) => writes.push(c), () => {}, {
      heartbeatMs: 1_000,
      maxMs: 60_000,
    });
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(1);

    stop(); // stream closed/finished
    vi.advanceTimersByTime(10_000);
    expect(writes).toHaveLength(1); // interval was cleared — no leak
  });

  it('fires onCap exactly once after the max-duration cap, then stop() prevents leak', () => {
    let capCount = 0;
    const stop = attachSseHeartbeat(() => {}, () => { capCount += 1; }, {
      heartbeatMs: 10_000,
      maxMs: 25_000,
    });

    vi.advanceTimersByTime(24_999);
    expect(capCount).toBe(0); // not yet
    vi.advanceTimersByTime(1);
    expect(capCount).toBe(1); // cap fired
    stop();
    vi.advanceTimersByTime(60_000);
    expect(capCount).toBe(1); // one-shot timeout, no repeat
  });

  it('stop() also clears the cap timer (no cap after a normal close)', () => {
    let capCount = 0;
    const stop = attachSseHeartbeat(() => {}, () => { capCount += 1; }, {
      heartbeatMs: 10_000,
      maxMs: 25_000,
    });
    stop(); // run completed before the cap
    vi.advanceTimersByTime(30_000);
    expect(capCount).toBe(0);
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

describe('hub discovery + virality (Phase 3)', () => {
  // Seed a HubGame on the InMemoryHubRepo with sensible field overrides.
  function seed(
    hubRepo: InMemoryHubRepo,
    over: Partial<Parameters<InMemoryHubRepo['seedGame']>[0]> &
      Pick<Parameters<InMemoryHubRepo['seedGame']>[0], 'id' | 'publishSlug'>,
  ): void {
    hubRepo.seedGame({
      projectId: `proj-${over.id}`,
      title: over.publishSlug,
      status: 'live',
      publishedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });
  }

  it('feed surfaces thumbnailUrl, genre, tags, and remixCount (#3.1/#3.4/#3.6)', async () => {
    const hubRepo = new InMemoryHubRepo();
    seed(hubRepo, {
      id: 'g1',
      publishSlug: 'pixel-jumper',
      thumbnailUrl: '/v1/blobs/abc123',
      genre: 'platformer',
      tags: ['platformer', 'showcase'],
    });
    const app = makeApp({ hubRepo });
    const res = await app.inject({ method: 'GET', url: '/v1/hub' });
    expect(res.statusCode).toBe(200);
    const game = (res.json() as { games: Array<Record<string, unknown>> }).games[0];
    expect(game).toMatchObject({
      publishSlug: 'pixel-jumper',
      thumbnailUrl: '/v1/blobs/abc123',
      genre: 'platformer',
      tags: ['platformer', 'showcase'],
      remixCount: 0,
    });
  });

  it('?sort=trending orders by recent play velocity (#3.3)', async () => {
    // Controllable clock so play-event timestamps are deterministic.
    let clock = 0;
    const hubRepo = new InMemoryHubRepo(() => clock);
    seed(hubRepo, { id: 'fresh', publishSlug: 'fresh', playCount: 1 });
    seed(hubRepo, { id: 'stale', publishSlug: 'stale', playCount: 100 });

    const NOW = 1_000_000_000_000;
    const WEEK_AGO = NOW - 7 * 24 * 60 * 60 * 1000;

    // 'stale' got 50 plays a week ago — heavily decayed under the 24h half-life.
    clock = WEEK_AGO;
    for (let i = 0; i < 50; i++) {
      await hubRepo.recordPlayEvent({ publishedGameId: 'stale', sessionHash: `old-${i}` });
    }
    // 'fresh' got 3 plays just now — undecayed.
    clock = NOW;
    for (let i = 0; i < 3; i++) {
      await hubRepo.recordPlayEvent({ publishedGameId: 'fresh', sessionHash: `new-${i}` });
    }

    const app = makeApp({ hubRepo });
    const res = await app.inject({ method: 'GET', url: '/v1/hub?sort=trending' });
    expect(res.statusCode).toBe(200);
    const games = (res.json() as { games: Array<{ publishSlug: string }> }).games;
    // Recent plays beat week-old plays under the 24h half-life decay.
    expect(games[0]?.publishSlug).toBe('fresh');

    // Sanity: ?sort=popular still ranks by raw playCount (stale wins there).
    const popular = await app.inject({ method: 'GET', url: '/v1/hub?sort=popular' });
    expect((popular.json() as { games: Array<{ publishSlug: string }> }).games[0]?.publishSlug).toBe('stale');
  });

  it('?genre= and ?tag= filter the feed (#3.4)', async () => {
    const hubRepo = new InMemoryHubRepo();
    seed(hubRepo, { id: 'p', publishSlug: 'plat', genre: 'platformer', tags: ['platformer', 'retro'] });
    seed(hubRepo, { id: 'f', publishSlug: 'fps', genre: 'fps', tags: ['fps', 'showcase'] });
    const app = makeApp({ hubRepo });

    const byGenre = await app.inject({ method: 'GET', url: '/v1/hub?genre=fps' });
    const g = (byGenre.json() as { games: Array<{ publishSlug: string }> }).games;
    expect(g).toHaveLength(1);
    expect(g[0]?.publishSlug).toBe('fps');

    const byTag = await app.inject({ method: 'GET', url: '/v1/hub?tag=retro' });
    const t = (byTag.json() as { games: Array<{ publishSlug: string }> }).games;
    expect(t).toHaveLength(1);
    expect(t[0]?.publishSlug).toBe('plat');
  });

  it('remix writes a lineage edge, increments remixCount, and returns parentSlug (#3.6)', async () => {
    const repo = new InMemoryProjectRepo();
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();

    // Source project + published game.
    const source = await repo.create({ ownerId: 'alice', name: 'Original', engine: 'phaser' });
    await repo.setCurrentManifestKey(source.id, 'manifest-key-1');
    await publishRepo.upsert({
      projectId: source.id,
      publishSlug: 'original',
      title: 'Original',
      bundleKey: 'bundle-1',
    });

    const app = makeApp({ repo, hubRepo, publishRepo });

    // Before remix: remixCount is 0.
    const before = await app.inject({ method: 'GET', url: '/v1/hub/games/original' });
    expect((before.json() as { game: { remixCount: number; parentSlug: string | null } }).game.remixCount).toBe(0);

    // Remix it.
    const remix = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/original/remix',
      headers: AS_BOB,
    });
    expect(remix.statusCode).toBe(201);
    const body = remix.json() as { projectId: string; parentSlug: string };
    expect(body.parentSlug).toBe('original');

    // Edge recorded → remixCount increments to 1.
    expect(await hubRepo.remixCount(source.id)).toBe(1);
    const after = await app.inject({ method: 'GET', url: '/v1/hub/games/original' });
    expect((after.json() as { game: { remixCount: number } }).game.remixCount).toBe(1);

    // The new project is a remix of the source (parentSlug attribution surfaces
    // on the child's published page once it publishes — lineage edge confirms it).
    const child = await repo.get(body.projectId);
    expect(child?.remixOfProjectId).toBe(source.id);
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
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/preview/`, headers: AS_ALICE });
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
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
  });

  it("blocks another user from previewing a run they don't own (#30 IDOR)", async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { manifestKey } = await store.write([
      { path: 'index.html', bytes: Buffer.from('<html>secret</html>') },
    ]);
    await runRepo.setSnapshot(run.id, manifestKey);

    const app = makeApp({ store, runRepo });
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/preview/`, headers: AS_BOB });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when run has no snapshot yet', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const app = makeApp({ store, runRepo });
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/preview/`, headers: AS_ALICE });
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

/**
 * Minimal BullMQ-Queue stub for the cancel route. Backs a single in-memory job
 * keyed by id with a settable state; records remove() calls. Shaped to satisfy
 * the `getJob` / `Job.getState` / `Job.remove` surface the route touches.
 */
function makeFakeGenerateQueue(opts?: { jobId?: string; state?: string }) {
  const removed: string[] = [];
  let jobState = opts?.state ?? 'waiting';
  const jobId = opts?.jobId;
  const job =
    jobId === undefined
      ? null
      : {
          async getState() {
            return jobState;
          },
          async remove() {
            removed.push(jobId);
            jobState = 'removed';
          },
        };
  const queue = {
    async getJob(id: string) {
      return id === jobId ? job : null;
    },
  } as unknown as NonNullable<ServerDeps['generateQueue']>;
  return { queue, removed };
}

/**
 * Refund-capable fake authDb for the cancel route. Unlike makeFakeAuthDb (which
 * only exposes `transaction`), the cancel refund inserts directly via
 * db.insert().values().onConflictDoNothing(), idempotent on (run_id) where
 * reason='refund'.
 */
function makeFakeRefundDb(): {
  authDb: ServerDeps['authDb'];
  inserted: Array<{ reason: string; delta: number; runId?: string }>;
} {
  const inserted: Array<{ reason: string; delta: number; runId?: string }> = [];
  const authDb = {
    insert: () => ({
      values: (row: { reason: string; delta: number; runId?: string }) => ({
        onConflictDoNothing: () => ({
          catch: async () => {
            const dup = inserted.some((r) => r.reason === row.reason && r.runId === row.runId);
            if (!dup) inserted.push(row);
          },
        }),
      }),
    }),
  } as unknown as ServerDeps['authDb'];
  return { authDb, inserted };
}

describe('run cancellation (2.7)', () => {
  function makeCancelApp(opts?: {
    runRepo?: InstanceType<typeof InMemoryRunRepo>;
    bus?: InstanceType<typeof InMemoryEventBus>;
    queue?: NonNullable<ServerDeps['generateQueue']>;
    authDb?: ServerDeps['authDb'];
  }) {
    return buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: opts?.bus ?? new InMemoryEventBus(),
      runRepo: opts?.runRepo ?? new InMemoryRunRepo(),
      enqueue: async () => {},
      ...(opts?.queue !== undefined ? { generateQueue: opts.queue } : {}),
      ...(opts?.authDb !== undefined ? { authDb: opts.authDb } : {}),
    });
  }

  it('cancels a waiting run: removes the job, marks canceled, publishes run_canceled, refunds once', async () => {
    const runRepo = new InMemoryRunRepo();
    const bus = new InMemoryEventBus();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue, removed } = makeFakeGenerateQueue({ jobId: run.id, state: 'waiting' });
    const { authDb, inserted } = makeFakeRefundDb();

    // Capture what lands on the run channel.
    const events: Array<{ type?: string }> = [];
    await bus.subscribe(runChannel(run.id), (m) => events.push(m as { type?: string }));

    const app = makeCancelApp({ runRepo, bus, queue, authDb });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'canceled', canceled: true });

    // Job removed from the queue.
    expect(removed).toEqual([run.id]);
    // Run persisted as canceled.
    expect((await runRepo.get(run.id))?.status).toBe('canceled');
    // run_canceled published so the SSE stream closes.
    expect(events.some((e) => e.type === 'run_canceled')).toBe(true);
    // Exactly one +CREDITS_PER_RUN refund row keyed on the run.
    const refunds = inserted.filter((r) => r.reason === 'refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ delta: 10, runId: run.id });
  });

  it('re-cancel is idempotent — second call is a no-op and inserts no second refund', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue } = makeFakeGenerateQueue({ jobId: run.id, state: 'waiting' });
    const { authDb, inserted } = makeFakeRefundDb();

    const app = makeCancelApp({ runRepo, queue, authDb });
    const first = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_ALICE });
    expect(first.statusCode).toBe(200);

    // Second cancel: run is already 'canceled' → terminal no-op, no second refund.
    const second = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_ALICE });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'canceled', canceled: true });
    expect(inserted.filter((r) => r.reason === 'refund')).toHaveLength(1);
  });

  it('returns 409 for an already-running run (active-cancel is a follow-up)', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await runRepo.updateStatus(run.id, 'running');
    const { queue, removed } = makeFakeGenerateQueue({ jobId: run.id, state: 'active' });

    const app = makeCancelApp({ runRepo, queue });
    const res = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_ALICE });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'active_run_cancel_unsupported' });
    // No job removal, status unchanged.
    expect(removed).toEqual([]);
    expect((await runRepo.get(run.id))?.status).toBe('running');
  });

  it('returns 200 no-op when the run is already terminal (completed)', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await runRepo.updateStatus(run.id, 'completed');
    const { queue } = makeFakeGenerateQueue({ jobId: run.id });

    const app = makeCancelApp({ runRepo, queue });
    const res = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_ALICE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'completed', canceled: false });
  });

  it('returns 503 when no generate queue is configured (no-Redis dev)', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const app = makeCancelApp({ runRepo }); // no queue
    const res = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_ALICE });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'cancel_unavailable' });
  });

  it("rejects cancelling another user's run with 404", async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue } = makeFakeGenerateQueue({ jobId: run.id });
    const app = makeCancelApp({ runRepo, queue });
    const res = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_BOB });
    expect(res.statusCode).toBe(404);
  });

  it('cancels a waiting run even when the job is already gone from the queue', async () => {
    // Job may have been consumed/expired; cancel must still persist + publish + refund.
    const runRepo = new InMemoryRunRepo();
    const bus = new InMemoryEventBus();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue } = makeFakeGenerateQueue(); // getJob returns null
    const { authDb, inserted } = makeFakeRefundDb();
    const events: Array<{ type?: string }> = [];
    await bus.subscribe(runChannel(run.id), (m) => events.push(m as { type?: string }));

    const app = makeCancelApp({ runRepo, bus, queue, authDb });
    const res = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/cancel`, headers: AS_ALICE });
    expect(res.statusCode).toBe(200);
    expect((await runRepo.get(run.id))?.status).toBe('canceled');
    expect(events.some((e) => e.type === 'run_canceled')).toBe(true);
    expect(inserted.filter((r) => r.reason === 'refund')).toHaveLength(1);
  });
});

describe('SSE relay terminal-event set (2.5b)', () => {
  it('closes the stream on a run_paused frame (Resume button keys on this shape)', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await bus.publish(runChannel(run.id), { type: 'tool_call', name: 'create_file' });
    await bus.publish(runChannel(run.id), { type: 'run_paused' });

    const app = makeApp({ bus, runRepo });
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/stream`, headers: AS_ALICE });

    // If run_paused weren't terminal, inject() would hang until timeout; getting
    // a completed 200 response proves finish() fired on the paused frame.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"run_paused"');
    const lines = res.body.split('\n').filter((l) => l.startsWith('data:'));
    // tool_call + run_paused; the exact {type:'run_paused'} frame is preserved.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('data: {"type":"run_paused"}');
  });

  it('closes the stream on a run_canceled frame', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await bus.publish(runChannel(run.id), { type: 'run_canceled' });

    const app = makeApp({ bus, runRepo });
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/stream`, headers: AS_ALICE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"run_canceled"');
  });
});
