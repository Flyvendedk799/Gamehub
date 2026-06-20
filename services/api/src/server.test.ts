import { InMemoryEventBus, runChannel } from '@playforge/bus';
import { InMemoryBlobStore, SnapshotStore } from '@playforge/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAccountRepo } from './account-repo';
import { type Authenticator, HeaderAuthenticator } from './auth';
import { InMemoryHubRepo } from './hub-repo';
import { InMemoryPublishRepo } from './publish-repo';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import {
  type EnqueueFn,
  SSE_HEARTBEAT_FRAME,
  type ServerDeps,
  attachSseHeartbeat,
  buildServer,
  decideAffordability,
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
  accountRepo?: InMemoryAccountRepo;
  allowedCorsOrigins?: string;
  sseMaxStreamMs?: number;
  auth?: Authenticator;
}) {
  return buildServer({
    repo: overrides?.repo ?? new InMemoryProjectRepo(),
    auth: overrides?.auth ?? new HeaderAuthenticator(),
    bus: overrides?.bus ?? new InMemoryEventBus(),
    runRepo: overrides?.runRepo ?? new InMemoryRunRepo(),
    enqueue: overrides?.enqueue ?? (async () => {}),
    ...(overrides?.store !== undefined ? { store: overrides.store } : {}),
    ...(overrides?.publishRepo !== undefined ? { publishRepo: overrides.publishRepo } : {}),
    ...(overrides?.hubRepo !== undefined ? { hubRepo: overrides.hubRepo } : {}),
    ...(overrides?.adminToken !== undefined ? { adminToken: overrides.adminToken } : {}),
    ...(overrides?.allowedCorsOrigins !== undefined
      ? { allowedCorsOrigins: overrides.allowedCorsOrigins }
      : {}),
    ...(overrides?.sseMaxStreamMs !== undefined
      ? { sseMaxStreamMs: overrides.sseMaxStreamMs }
      : {}),
    ...(overrides?.accountRepo !== undefined
      ? {
          accountRepo: overrides.accountRepo,
          apiKeyEncryptionSecret: 'test-secret',
          platformModel: { provider: 'openai', modelId: 'o4-mini' },
        }
      : {}),
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

describe('cors', () => {
  it('answers local dev preflight requests', async () => {
    const res = await makeApp().inject({
      method: 'OPTIONS',
      url: '/v1/auth/register',
      headers: {
        origin: 'http://localhost:3004',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3004');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('uses explicit CORS origins when configured', async () => {
    const app = makeApp({ allowedCorsOrigins: 'https://app.playforge.test' });
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/register',
      headers: {
        origin: 'https://app.playforge.test',
        'access-control-request-method': 'POST',
      },
    });
    const local = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/register',
      headers: {
        origin: 'http://localhost:3004',
        'access-control-request-method': 'POST',
      },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.playforge.test');
    expect(local.statusCode).toBe(404);
    expect(local.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('auth', () => {
  it('rejects unauthenticated project access', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
  });
});

describe('account settings', () => {
  function makeAccountApp() {
    const accountRepo = new InMemoryAccountRepo();
    accountRepo.ensureUser('alice', 'alice');
    const repo = new InMemoryProjectRepo();
    const enqueued: Parameters<EnqueueFn>[0][] = [];
    const app = makeApp({
      repo,
      accountRepo,
      enqueue: async (input) => {
        enqueued.push(input);
      },
    });
    return { app, repo, enqueued };
  }

  it('returns profile and provider metadata without exposing ciphertext', async () => {
    const { app } = makeAccountApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account/settings',
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { handle: 'alice' },
      defaultProvider: 'platform',
      onboardingComplete: false,
    });
    expect(JSON.stringify(res.json())).not.toContain('ciphertext');
  });

  it('requires a key before switching to Claude or OpenAI', async () => {
    const { app } = makeAccountApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/account/provider',
      headers: AS_ALICE,
      payload: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'api_key_required', provider: 'anthropic' });
  });

  it('saves a Claude key, masks it, and uses it for generation', async () => {
    const { app, repo, enqueued } = makeAccountApp();
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/account/provider',
      headers: AS_ALICE,
      payload: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        apiKey: 'sk-ant-test-1234',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      defaultProvider: 'anthropic',
      defaultModelId: 'claude-sonnet-4-6',
      onboardingComplete: true,
    });
    const anthropic = saved
      .json()
      .providers.find((p: { provider: string }) => p.provider === 'anthropic');
    expect(anthropic).toMatchObject({ configured: true, last4: '1234' });
    expect(JSON.stringify(saved.json())).not.toContain('sk-ant-test-1234');

    const project = await repo.create({ ownerId: 'alice', name: 'BYOK', engine: 'phaser' });
    const generated = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'make a tiny platformer' },
    });
    expect(generated.statusCode).toBe(202);
    expect(enqueued[0]).toMatchObject({
      apiKey: 'sk-ant-test-1234',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
    });
  });

  it('falls back to platform when the active provider key is deleted', async () => {
    const { app } = makeAccountApp();
    await app.inject({
      method: 'PUT',
      url: '/v1/account/provider',
      headers: AS_ALICE,
      payload: { provider: 'openai', modelId: 'gpt-4o', apiKey: 'sk-openai-9999' },
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/v1/account/provider/openai',
      headers: AS_ALICE,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ defaultProvider: 'platform' });
    const openai = deleted
      .json()
      .providers.find((p: { provider: string }) => p.provider === 'openai');
    expect(openai).toMatchObject({ configured: false, last4: null });
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

  it('build report: 404 for a run the requester does not own', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const app = makeApp({ bus, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/report`,
      headers: AS_BOB,
    });
    expect(res.statusCode).toBe(404);
  });

  it('build report: 503 when the telemetry DB is not configured', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const app = makeApp({ bus, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/report`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'report_unavailable' });
  });

  it('adds CORS headers to hijacked SSE responses', async () => {
    const bus = new InMemoryEventBus();
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await bus.publish(runChannel(run.id), { type: 'run_complete' });
    const app = makeApp({
      bus,
      runRepo,
      allowedCorsOrigins: 'http://localhost:3004 http://127.0.0.1:3004',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: {
        ...AS_ALICE,
        origin: 'http://localhost:3004',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3004');
    expect(res.headers.vary).toBe('Origin');
  });

  it('flushes CORS headers before a quiet SSE stream emits events', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const app = makeApp({
      runRepo,
      allowedCorsOrigins: 'http://localhost:3004',
      sseMaxStreamMs: 5,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: {
        ...AS_ALICE,
        origin: 'http://localhost:3004',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3004');
    expect(res.headers['content-type']).toBe('text/event-stream');
  });

  it('unsubscribes from the bus when the stream ends (no leaked subscription) (C1)', async () => {
    // Wrap a real InMemoryEventBus and count how many of the unsubscribe handles
    // it hands out are actually invoked. The production RedisEventBus leaks a
    // dedicated blocking-XREAD Redis connection per un-invoked unsubscribe, so a
    // completed stream MUST call it.
    const inner = new InMemoryEventBus();
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const trackingBus = {
      publish: (c: string, m: unknown) => inner.publish(c, m),
      close: () => inner.close(),
      subscribe: async (c: string, h: (m: unknown) => void) => {
        subscribeCount += 1;
        const unsub = await inner.subscribe(c, h);
        return () => {
          unsubscribeCount += 1;
          unsub();
        };
      },
    } as unknown as InstanceType<typeof InMemoryEventBus>;

    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    await inner.publish(runChannel(run.id), { type: 'run_complete' });

    const app = makeApp({ bus: trackingBus, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_ALICE,
    });

    expect(res.statusCode).toBe(200);
    expect(subscribeCount).toBe(1);
    // The stream finished (run_complete replayed synchronously) → unsubscribe ran.
    expect(unsubscribeCount).toBe(1);
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
    const event = JSON.parse(dataLine.replace('data: ', '')) as {
      type: string;
      previewUrl?: string;
    };
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
    const stop = attachSseHeartbeat(
      (c) => writes.push(c),
      () => {},
      {
        heartbeatMs: 1_000,
        maxMs: 60_000,
      },
    );

    expect(writes).toHaveLength(0); // nothing yet
    vi.advanceTimersByTime(1_000);
    expect(writes).toEqual([SSE_HEARTBEAT_FRAME]);
    vi.advanceTimersByTime(2_000);
    expect(writes).toEqual([SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME]);
    stop();
  });

  it('stop() clears the interval — no further frames after close', () => {
    const writes: string[] = [];
    const stop = attachSseHeartbeat(
      (c) => writes.push(c),
      () => {},
      {
        heartbeatMs: 1_000,
        maxMs: 60_000,
      },
    );
    vi.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(1);

    stop(); // stream closed/finished
    vi.advanceTimersByTime(10_000);
    expect(writes).toHaveLength(1); // interval was cleared — no leak
  });

  it('fires onCap exactly once after the max-duration cap, then stop() prevents leak', () => {
    let capCount = 0;
    const stop = attachSseHeartbeat(
      () => {},
      () => {
        capCount += 1;
      },
      {
        heartbeatMs: 10_000,
        maxMs: 25_000,
      },
    );

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
    const stop = attachSseHeartbeat(
      () => {},
      () => {
        capCount += 1;
      },
      {
        heartbeatMs: 10_000,
        maxMs: 25_000,
      },
    );
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
    await publishRepo.upsert({
      projectId: 'p1',
      publishSlug: 'my-game',
      title: 'My Game',
      bundleKey: 'k',
    });

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

describe('content / identity hardening (pre-launch audit)', () => {
  it('rejects self-rating and self-like, but allows another user (content MEDIUM)', async () => {
    const repo = new InMemoryProjectRepo();
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    // Alice owns the project behind the published game.
    const proj = await repo.create({ ownerId: 'alice', name: 'Alice Game' });
    await publishRepo.upsert({
      projectId: proj.id,
      publishSlug: 'alice-game',
      title: 'Alice Game',
      bundleKey: 'k',
    });

    const app = makeApp({ repo, hubRepo, publishRepo });

    const selfRate = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/alice-game/rate',
      headers: AS_ALICE,
      payload: { stars: 5 },
    });
    expect(selfRate.statusCode).toBe(400);
    expect(selfRate.json()).toMatchObject({ error: 'cannot_rate_own' });

    const selfLike = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/alice-game/like',
      headers: AS_ALICE,
    });
    expect(selfLike.statusCode).toBe(400);
    expect(selfLike.json()).toMatchObject({ error: 'cannot_like_own' });

    // Bob (not the owner) can rate and like.
    const bobRate = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/alice-game/rate',
      headers: AS_BOB,
      payload: { stars: 4 },
    });
    expect(bobRate.statusCode).toBe(200);
    const bobLike = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/alice-game/like',
      headers: AS_BOB,
    });
    expect(bobLike.statusCode).toBe(200);
  });

  it('caps project name length on create and rename (content MEDIUM)', async () => {
    const app = makeApp();
    const long = 'x'.repeat(121);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: long },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toMatchObject({ error: 'name_too_long' });

    // A valid create then an over-long rename.
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'fine' },
    });
    const id = (ok.json() as { id: string }).id;
    const rename = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: AS_ALICE,
      payload: { name: long },
    });
    expect(rename.statusCode).toBe(400);
    expect(rename.json()).toMatchObject({ error: 'name_too_long' });
  });

  it('rejects a forged remixOfProjectId pointing at a non-existent project (auth M3)', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'fake remix', remixOfProjectId: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_remix_parent' });
  });

  it('allows a remix of a real non-private project', async () => {
    const repo = new InMemoryProjectRepo();
    const parent = await repo.create({ ownerId: 'bob', name: 'Parent', visibility: 'public' });
    const app = makeApp({ repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: AS_ALICE,
      payload: { name: 'real remix', remixOfProjectId: parent.id },
    });
    expect(res.statusCode).toBe(201);
  });

  it('caps hub comment body length (content MEDIUM)', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    await publishRepo.upsert({ projectId: 'p1', publishSlug: 'g', title: 'G', bundleKey: 'k' });
    const app = makeApp({ hubRepo, publishRepo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/g/comments',
      headers: AS_BOB,
      payload: { body: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'comment_too_long' });
  });

  it('chat history is owner-only even for a public project (auth M1)', async () => {
    const repo = new InMemoryProjectRepo();
    const proj = await repo.create({ ownerId: 'alice', name: 'Pub', visibility: 'public' });
    const app = makeApp({ repo });
    // Owner can read.
    const owner = await app.inject({
      method: 'GET',
      url: `/v1/projects/${proj.id}/chat`,
      headers: AS_ALICE,
    });
    expect(owner.statusCode).toBe(200);
    // A non-owner gets 404 even though the project is public.
    const other = await app.inject({
      method: 'GET',
      url: `/v1/projects/${proj.id}/chat`,
      headers: AS_BOB,
    });
    expect(other.statusCode).toBe(404);
  });

  it('admin queue-depth requires the admin token (auth H3)', async () => {
    const app = makeApp({ adminToken: 'sekret' });
    const noAuth = await app.inject({ method: 'GET', url: '/v1/admin/queue-depth' });
    expect(noAuth.statusCode).toBe(403);
    const withAuth = await app.inject({
      method: 'GET',
      url: '/v1/admin/queue-depth',
      headers: { 'x-admin-token': 'sekret' },
    });
    expect(withAuth.statusCode).toBe(200);
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
    expect(
      (popular.json() as { games: Array<{ publishSlug: string }> }).games[0]?.publishSlug,
    ).toBe('stale');
  });

  it('?genre= and ?tag= filter the feed (#3.4)', async () => {
    const hubRepo = new InMemoryHubRepo();
    seed(hubRepo, {
      id: 'p',
      publishSlug: 'plat',
      genre: 'platformer',
      tags: ['platformer', 'retro'],
    });
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
    expect(
      (before.json() as { game: { remixCount: number; parentSlug: string | null } }).game
        .remixCount,
    ).toBe(0);

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

describe('leaderboards (Phase 3.8)', () => {
  async function seedGame(publishRepo: InMemoryPublishRepo, slug: string): Promise<void> {
    await publishRepo.upsert({
      projectId: `proj-${slug}`,
      publishSlug: slug,
      title: slug,
      bundleKey: 'k',
    });
  }

  it('POST /score returns 404 for an unknown slug', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    const app = makeApp({ hubRepo, publishRepo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/play/nope/score',
      payload: { score: 5 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /score rejects a non-integer/negative score with 400', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    await seedGame(publishRepo, 'game');
    const app = makeApp({ hubRepo, publishRepo });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/play/game/score',
      payload: { score: 1.5 },
    });
    expect(bad.statusCode).toBe(400);
    const neg = await app.inject({
      method: 'POST',
      url: '/v1/play/game/score',
      payload: { score: -1 },
    });
    expect(neg.statusCode).toBe(400);
  });

  it('records a score and surfaces it in the top-10 leaderboard, highest first', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    await seedGame(publishRepo, 'game');
    // Seed handles so signed-in scores resolve a @handle in the response.
    hubRepo.seedUser('alice', { handle: 'alice' });
    hubRepo.seedUser('bob', { handle: 'bob' });
    const app = makeApp({ hubRepo, publishRepo });

    // alice submits 100, bob submits 250 (different sessions via different IP isn't
    // testable through inject, so submit directly through the repo for ordering and
    // use the route for the happy-path acceptance below).
    await hubRepo.addScore({
      publishedGameId: (await publishRepo.getBySlug('game'))!.id,
      userId: 'alice',
      score: 100,
    });
    await hubRepo.addScore({
      publishedGameId: (await publishRepo.getBySlug('game'))!.id,
      userId: 'bob',
      score: 250,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/play/game/leaderboard' });
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { entries: Array<{ score: number; handle: string | null }> })
      .entries;
    expect(entries).toHaveLength(2);
    // Highest score first.
    expect(entries[0]).toMatchObject({ score: 250, handle: 'bob' });
    expect(entries[1]).toMatchObject({ score: 100, handle: 'alice' });
  });

  it('caps to top-10 even when more scores were submitted', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    await seedGame(publishRepo, 'game');
    const app = makeApp({ hubRepo, publishRepo });
    const gameId = (await publishRepo.getBySlug('game'))!.id;
    for (let i = 1; i <= 15; i++) {
      await hubRepo.addScore({ publishedGameId: gameId, score: i });
    }
    const res = await app.inject({ method: 'GET', url: '/v1/play/game/leaderboard' });
    const entries = (res.json() as { entries: Array<{ score: number }> }).entries;
    expect(entries).toHaveLength(10);
    // Top is the highest score (15), tenth is 6.
    expect(entries[0]?.score).toBe(15);
    expect(entries[9]?.score).toBe(6);
  });

  it('rate-caps repeated submissions from the same session to one per window', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    await seedGame(publishRepo, 'game');
    const app = makeApp({ hubRepo, publishRepo });

    // First submission from this session is accepted.
    const first = await app.inject({
      method: 'POST',
      url: '/v1/play/game/score',
      payload: { score: 10 },
    });
    expect(first.statusCode).toBe(201);
    // Second from the same session (same ip) is rate-limited.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/play/game/score',
      payload: { score: 999 },
    });
    expect(second.statusCode).toBe(429);

    // Only the first score landed on the board.
    const board = await app.inject({ method: 'GET', url: '/v1/play/game/leaderboard' });
    const entries = (board.json() as { entries: Array<{ score: number }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.score).toBe(10);
  });
});

describe('creator follow + profile (Phase 3.9)', () => {
  it('GET /v1/users/:handle includes followerCount + isFollowing', async () => {
    const repo = new InMemoryProjectRepo();
    const hubRepo = new InMemoryHubRepo();
    const app = makeApp({ repo, hubRepo });
    // In the header-auth harness, the URL "handle" == the followee's userId.
    const res = await app.inject({ method: 'GET', url: '/v1/users/creator' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ handle: 'creator', followerCount: 0, isFollowing: false });
  });

  it('follow is idempotent and increments followerCount; isFollowing reflects the viewer', async () => {
    const repo = new InMemoryProjectRepo();
    const hubRepo = new InMemoryHubRepo();
    const app = makeApp({ repo, hubRepo });

    // alice follows creator.
    const follow = await app.inject({
      method: 'POST',
      url: '/v1/users/creator/follow',
      headers: AS_ALICE,
    });
    expect(follow.statusCode).toBe(200);
    expect(follow.json()).toMatchObject({ following: true, followerCount: 1 });

    // Following again is a no-op — count stays 1 (idempotent via the unique edge).
    const again = await app.inject({
      method: 'POST',
      url: '/v1/users/creator/follow',
      headers: AS_ALICE,
    });
    expect((again.json() as { followerCount: number }).followerCount).toBe(1);

    // The profile now reports isFollowing=true for alice, false for bob.
    const asAlice = await app.inject({
      method: 'GET',
      url: '/v1/users/creator',
      headers: AS_ALICE,
    });
    expect(asAlice.json()).toMatchObject({ followerCount: 1, isFollowing: true });
    const asBob = await app.inject({ method: 'GET', url: '/v1/users/creator', headers: AS_BOB });
    expect(asBob.json()).toMatchObject({ followerCount: 1, isFollowing: false });

    // Unfollow drops the count back to 0.
    const unfollow = await app.inject({
      method: 'DELETE',
      url: '/v1/users/creator/follow',
      headers: AS_ALICE,
    });
    expect(unfollow.json()).toMatchObject({ following: false, followerCount: 0 });
  });

  it('rejects a self-follow with 400', async () => {
    const repo = new InMemoryProjectRepo();
    const hubRepo = new InMemoryHubRepo();
    const app = makeApp({ repo, hubRepo });
    // alice's userId == the URL handle "alice" → self-follow.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/alice/follow',
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'cannot_follow_self' });
  });

  it('follow requires auth', async () => {
    const hubRepo = new InMemoryHubRepo();
    const app = makeApp({ hubRepo });
    const res = await app.inject({ method: 'POST', url: '/v1/users/creator/follow' });
    expect(res.statusCode).toBe(401);
  });

  it('listComments author-resolves a handle for the web to link to /u/:handle', async () => {
    const hubRepo = new InMemoryHubRepo();
    const publishRepo = new InMemoryPublishRepo();
    await publishRepo.upsert({
      projectId: 'p1',
      publishSlug: 'my-game',
      title: 'My Game',
      bundleKey: 'k',
    });
    hubRepo.seedUser('alice', { handle: 'alice', displayName: 'Alice A' });
    const app = makeApp({ hubRepo, publishRepo });

    // alice comments.
    const post = await app.inject({
      method: 'POST',
      url: '/v1/hub/games/my-game/comments',
      headers: AS_ALICE,
      payload: { body: 'nice game' },
    });
    expect(post.statusCode).toBe(201);
    expect((post.json() as { comment: { authorHandle: string | null } }).comment.authorHandle).toBe(
      'alice',
    );

    // The list carries the resolved author handle + displayName.
    const list = await app.inject({ method: 'GET', url: '/v1/hub/games/my-game/comments' });
    const comments = (
      list.json() as {
        comments: Array<{ authorHandle: string | null; authorDisplayName: string | null }>;
      }
    ).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorHandle: 'alice', authorDisplayName: 'Alice A' });
  });
});

describe('preview route', () => {
  it('serves index.html from a run snapshot', async () => {
    const blobStore = new InMemoryBlobStore();
    const store = new SnapshotStore(blobStore);
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const html = '<html><body><script type="module" src="src/main.js"></script></body></html>';
    const { manifestKey } = await store.write([{ path: 'index.html', bytes: Buffer.from(html) }]);
    await runRepo.setSnapshot(run.id, manifestKey);

    const app = makeApp({ store, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/preview/`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toEqual(
      expect.stringContaining("script-src 'self'"),
    );
    expect(res.headers['content-security-policy']).toEqual(
      expect.stringContaining('https://cdn.jsdelivr.net'),
    );
    expect(res.headers['content-security-policy']).toEqual(
      expect.stringContaining("connect-src 'self'"),
    );
    expect(res.body).toBe(html);
  });

  it('uses a scoped preview auth cookie for generated subresources', async () => {
    const blobStore = new InMemoryBlobStore();
    const store = new SnapshotStore(blobStore);
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const auth: Authenticator = {
      async authenticate(headers) {
        const raw = headers['authorization'];
        const authHeader = Array.isArray(raw) ? raw[0] : raw;
        return authHeader === 'Bearer session-alice' ? { userId: 'alice', handle: 'alice' } : null;
      },
    };

    const { manifestKey } = await store.write([
      {
        path: 'index.html',
        bytes: Buffer.from('<script type="module" src="src/main.js"></script>'),
      },
      { path: 'src/main.js', bytes: Buffer.from('console.log("ok");') },
    ]);
    await runRepo.setSnapshot(run.id, manifestKey);

    const app = makeApp({ store, runRepo, auth });
    const html = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/preview/?token=session-alice`,
    });
    expect(html.statusCode).toBe(200);
    const setCookie = html.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toEqual(expect.stringContaining('pf_preview_auth='));
    expect(cookieHeader).toEqual(expect.stringContaining(`Path=/v1/runs/${run.id}/preview/`));
    const cookiePair = cookieHeader?.split(';')[0];
    expect(cookiePair).toBeDefined();

    const script = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/preview/src/main.js`,
      headers: { cookie: cookiePair ?? '' },
    });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.body).toBe('console.log("ok");');
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
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/preview/`,
      headers: AS_BOB,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when run has no snapshot yet', async () => {
    const store = new SnapshotStore(new InMemoryBlobStore());
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });

    const app = makeApp({ store, runRepo });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/preview/`,
      headers: AS_ALICE,
    });
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
    const pausedContinuation = {
      todos: null,
      decisionRecap: 'half built',
      fsState: {},
      originalUserPrompt: 'build a platformer',
    };
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
      enqueue: async (input) => {
        enqueued.push(input.runId);
      },
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
      await (
        tx as unknown as {
          insert: () => { values: (r: unknown) => { onConflictDoNothing: () => Promise<void> } };
        }
      )
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
function makeFakeRefundDb(opts?: { reserved?: boolean }): {
  authDb: ServerDeps['authDb'];
  inserted: Array<{ reason: string; delta: number; runId?: string }>;
} {
  // These tests model a PLATFORM run that reserved credits up front, so the
  // cancel/fail path refunds it. refundRunReservation only refunds when a
  // 'reservation' row exists; seed one (set reserved:false to model a BYOK/
  // subscription run that never reserved → no refund).
  const inserted: Array<{ reason: string; delta: number; runId?: string }> =
    opts?.reserved === false ? [] : [{ reason: 'reservation', delta: -10, runId: 'seed' }];
  const authDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            inserted.filter((r) => r.reason === 'reservation').map((r) => ({ runId: r.runId })),
        }),
      }),
    }),
    insert: () => ({
      values: (row: { reason: string; delta: number; runId?: string }) => ({
        onConflictDoNothing: async () => {
          const dup = inserted.some((r) => r.reason === row.reason && r.runId === row.runId);
          if (!dup) inserted.push(row);
        },
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

  it('does NOT refund a non-platform run (BYOK/subscription never reserved → no credit printing)', async () => {
    const runRepo = new InMemoryRunRepo();
    const bus = new InMemoryEventBus();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue } = makeFakeGenerateQueue({ jobId: run.id, state: 'waiting' });
    const { authDb, inserted } = makeFakeRefundDb({ reserved: false });
    const app = makeCancelApp({ runRepo, bus, queue, authDb });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });

    expect(res.statusCode).toBe(200);
    // No reservation existed (the run funded its own compute) → no refund row,
    // which would otherwise hand the user free credits.
    expect(inserted.filter((r) => r.reason === 'refund')).toHaveLength(0);
  });

  it('re-cancel is idempotent — second call is a no-op and inserts no second refund', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue } = makeFakeGenerateQueue({ jobId: run.id, state: 'waiting' });
    const { authDb, inserted } = makeFakeRefundDb();

    const app = makeCancelApp({ runRepo, queue, authDb });
    const first = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });
    expect(first.statusCode).toBe(200);

    // Second cancel: run is already 'canceled' → terminal no-op, no second refund.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });
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
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });
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
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'completed', canceled: false });
  });

  it('returns 503 when no generate queue is configured (no-Redis dev)', async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const app = makeCancelApp({ runRepo }); // no queue
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'cancel_unavailable' });
  });

  it("rejects cancelling another user's run with 404", async () => {
    const runRepo = new InMemoryRunRepo();
    const run = await runRepo.create({ projectId: 'proj_test', userId: 'alice' });
    const { queue } = makeFakeGenerateQueue({ jobId: run.id });
    const app = makeCancelApp({ runRepo, queue });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_BOB,
    });
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
    const res = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/cancel`,
      headers: AS_ALICE,
    });
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
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_ALICE,
    });

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
    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: AS_ALICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"run_canceled"');
  });
});

// ── Phase 6 fixtures: an in-memory authDb that mimics the slice of the Drizzle
//    query surface the purchase + reset routes touch. It routes on the table
//    object identity passed to .from()/.update()/.delete(), backs four arrays
//    (users / credit ledger / reset tokens / sessions), and honours the partial
//    unique on (user_id, stripe_event_id) for the idempotent purchase grant and
//    the unused-token gate for the reset burn. Enough to exercise webhook
//    idempotency, the balance<10→purchase→generate unlock, and the full reset
//    round-trip without a live Postgres. ───────────────────────────────────────

import { createHash } from 'node:crypto';
import { schema as dbSchema } from '@playforge/db';
import { hashPassword as hashPasswordReal, verifyPassword as verifyPasswordReal } from './auth';
import { CapturingEmailTransport, MockCreditProvider } from './index';

interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  handle: string;
  deletedAt: Date | null;
}
interface FakeLedger {
  userId: string;
  delta: number;
  reason: string;
  stripeEventId?: string | null;
  runId?: string | null;
}
interface FakeResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}
interface FakeSession {
  token: string;
  userId: string;
}

function makePhase6Db(seed?: {
  users?: FakeUser[];
  ledger?: FakeLedger[];
  sessions?: FakeSession[];
}) {
  const users: FakeUser[] = seed?.users ?? [];
  const ledger: FakeLedger[] = seed?.ledger ?? [];
  const resetTokens: FakeResetToken[] = [];
  const sessions: FakeSession[] = seed?.sessions ?? [];
  let tokenSeq = 0;

  const balanceOf = (userId: string) =>
    ledger.filter((r) => r.userId === userId).reduce((n, r) => n + r.delta, 0);

  // A query builder whose terminal `where`/result resolves against the stores.
  // The select handlers are keyed by the table passed to from().
  const makeBuilder = () => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      select: () => builder,
      from: (t: unknown) => {
        table = t;
        return builder;
      },
      // Terminal: the route awaits where() (the last call). We can't see the
      // predicate, so branch on the table captured by from() and resolve against
      // the in-memory stores. Tests seed exactly one user/token so this is exact.
      where: async () => {
        if (table === dbSchema.users) {
          return users.filter((u) => u.deletedAt === null).map((u) => ({ id: u.id }));
        }
        if (table === dbSchema.creditLedger) {
          // getUserBalance + the reservation SUM, for the single seeded user.
          const uid = users[0]?.id ?? '';
          return [{ bal: balanceOf(uid) }];
        }
        if (table === dbSchema.passwordResetTokens) {
          // Reset route: the single unexpired + unused token, if any.
          const now = Date.now();
          return resetTokens
            .filter((t) => t.usedAt === null && t.expiresAt.getTime() > now)
            .map((t) => ({ id: t.id, userId: t.userId }));
        }
        return [];
      },
    };
    return builder;
  };

  const insertChain = (table: unknown) => ({
    values: (row: Record<string, unknown>) => {
      const apply = () => {
        if (table === dbSchema.creditLedger) {
          const r = row as unknown as FakeLedger;
          // Honour the partial unique on (user_id, stripe_event_id).
          if (r.stripeEventId != null) {
            const dup = ledger.some(
              (x) => x.userId === r.userId && x.stripeEventId === r.stripeEventId,
            );
            if (dup) return;
          }
          ledger.push({ ...r });
        } else if (table === dbSchema.passwordResetTokens) {
          const r = row as { userId: string; tokenHash: string; expiresAt: Date };
          resetTokens.push({
            id: `tok_${++tokenSeq}`,
            userId: r.userId,
            tokenHash: r.tokenHash,
            expiresAt: r.expiresAt,
            usedAt: null,
          });
        }
      };
      return {
        // purchase grant awaits onConflictDoNothing() directly.
        onConflictDoNothing: async () => {
          apply();
        },
        // token mint awaits values() result directly (no onConflict) — make the
        // returned object thenable so `await db.insert().values(...)` applies it.
        // biome-ignore lint/suspicious/noThenProperty: intentional awaitable mock of the Drizzle insert chain.
        then: (resolve: (v: unknown) => void) => {
          apply();
          resolve(undefined);
        },
      };
    },
  });

  // tx.update(t).set(p).where(...) is used two ways: the token-burn chains
  // .returning(); the users password update awaits the .where(...) directly. So
  // where(...) returns an object that is BOTH thenable (applies the users patch
  // on await) AND exposes .returning() (applies the token burn). The applied
  // side-effect depends on the table.
  const txApi = {
    // The credit-RESERVATION path runs inside a transaction: an advisory lock
    // (execute), a balance SUM (select.from.where), then an idempotent negative
    // insert. Mirror the db-level surface so a purchase-unlocked /generate works.
    execute: async () => undefined,
    select: () => makeBuilder(),
    insert: (table: unknown) => insertChain(table),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const applyUsers = () => {
            if (table === dbSchema.users) {
              const u = users[0];
              if (u) u.passwordHash = patch['passwordHash'] as string;
            }
          };
          const burnToken = (): Array<{ id: string }> => {
            // Gate on used_at IS NULL — a racing double-submit burns once.
            const tok = resetTokens.find((t) => t.usedAt === null);
            if (!tok) return [];
            tok.usedAt = (patch['usedAt'] as Date) ?? new Date();
            return [{ id: tok.id }];
          };
          return {
            // Awaited directly (users password update path).
            // biome-ignore lint/suspicious/noThenProperty: intentional awaitable mock of the Drizzle update chain.
            then: (resolve: (v: unknown) => void) => {
              applyUsers();
              resolve(undefined);
            },
            // Chained for the token-burn path.
            returning: async () => burnToken(),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === dbSchema.sessions) {
          const uid = users[0]?.id;
          for (let i = sessions.length - 1; i >= 0; i--)
            if (sessions[i]?.userId === uid) sessions.splice(i, 1);
        }
        return undefined;
      },
    }),
  };

  const db = {
    select: () => makeBuilder(),
    insert: (table: unknown) => insertChain(table),
    transaction: async (fn: (tx: typeof txApi) => Promise<void>) => {
      await fn(txApi);
    },
  } as unknown as NonNullable<ServerDeps['authDb']>;

  return { db, users, ledger, resetTokens, sessions, balanceOf };
}

describe('credit purchase (6.1)', () => {
  function makePurchaseApp(opts: {
    authDb: NonNullable<ServerDeps['authDb']>;
    eventId?: string;
  }) {
    return buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
      authDb: opts.authDb,
      creditProvider: new MockCreditProvider({ eventIdFactory: () => opts.eventId ?? 'evt_fixed' }),
    });
  }

  it('grants the pack credits and returns the new balance', async () => {
    const { db, ledger } = makePhase6Db({
      users: [
        { id: 'alice', email: 'a@x.io', passwordHash: 'h', handle: 'alice', deletedAt: null },
      ],
    });
    const app = makePurchaseApp({ authDb: db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credits/purchase',
      headers: AS_ALICE,
      payload: { pack: 'starter' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      pack: { id: 'starter', credits: 100 },
      balance: 100,
      confirmed: true,
    });
    expect(ledger.filter((r) => r.reason === 'purchase')).toHaveLength(1);
  });

  it('is idempotent on the external event id — a re-fired webhook grants once', async () => {
    const { db, balanceOf } = makePhase6Db({
      users: [
        { id: 'alice', email: 'a@x.io', passwordHash: 'h', handle: 'alice', deletedAt: null },
      ],
    });
    const app = makePurchaseApp({ authDb: db, eventId: 'evt_dup' });
    await app.inject({
      method: 'POST',
      url: '/v1/credits/purchase',
      headers: AS_ALICE,
      payload: { pack: 'starter' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/credits/purchase',
      headers: AS_ALICE,
      payload: { pack: 'starter' },
    });
    // Same event id both times → exactly one +100 grant.
    expect(balanceOf('alice')).toBe(100);
  });

  it('rejects an unknown pack with 400', async () => {
    const { db } = makePhase6Db({
      users: [
        { id: 'alice', email: 'a@x.io', passwordHash: 'h', handle: 'alice', deletedAt: null },
      ],
    });
    const app = makePurchaseApp({ authDb: db });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credits/purchase',
      headers: AS_ALICE,
      payload: { pack: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unknown_pack' });
  });

  it('503 when no credit provider is configured', async () => {
    const { db } = makePhase6Db({
      users: [
        { id: 'alice', email: 'a@x.io', passwordHash: 'h', handle: 'alice', deletedAt: null },
      ],
    });
    const app = buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
      authDb: db,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credits/purchase',
      headers: AS_ALICE,
      payload: { pack: 'starter' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /v1/credits/balance returns SUM(delta)', async () => {
    const { db } = makePhase6Db({
      users: [
        { id: 'alice', email: 'a@x.io', passwordHash: 'h', handle: 'alice', deletedAt: null },
      ],
      ledger: [
        { userId: 'alice', delta: 100, reason: 'welcome_grant' },
        { userId: 'alice', delta: -10, reason: 'reservation' },
      ],
    });
    const app = makePurchaseApp({ authDb: db });
    const res = await app.inject({ method: 'GET', url: '/v1/credits/balance', headers: AS_ALICE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ balance: 90 });
  });

  it('a balance<10 user can purchase and then /generate (was 402)', async () => {
    // Seed alice with 5 credits — below the 10-credit run cost.
    const { db, balanceOf } = makePhase6Db({
      users: [
        { id: 'alice', email: 'a@x.io', passwordHash: 'h', handle: 'alice', deletedAt: null },
      ],
      ledger: [{ userId: 'alice', delta: 5, reason: 'welcome_grant' }],
    });
    const repo = new InMemoryProjectRepo();
    const runRepo = new InMemoryRunRepo();
    const project = await repo.create({ ownerId: 'alice', name: 'Unlock', engine: 'phaser' });
    const enqueued: string[] = [];
    const app = buildServer({
      repo,
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo,
      enqueue: async (i) => {
        enqueued.push(i.runId);
      },
      authDb: db,
      creditProvider: new MockCreditProvider({ eventIdFactory: () => 'evt_unlock' }),
    });

    // Pre-purchase: generate is blocked with 402.
    const before = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'go' },
    });
    expect(before.statusCode).toBe(402);
    expect(enqueued).toHaveLength(0);

    // Purchase a pack → balance jumps well above the run cost.
    const buy = await app.inject({
      method: 'POST',
      url: '/v1/credits/purchase',
      headers: AS_ALICE,
      payload: { pack: 'starter' },
    });
    expect(buy.statusCode).toBe(200);
    expect(balanceOf('alice')).toBe(105);

    // Post-purchase: generate now succeeds (202) and enqueues.
    const after = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/generate`,
      headers: AS_ALICE,
      payload: { prompt: 'go' },
    });
    expect(after.statusCode).toBe(202);
    expect(enqueued).toHaveLength(1);
  });
});

describe('password reset (6.2)', () => {
  const ALICE: FakeUser = {
    id: 'alice',
    email: 'alice@example.com',
    passwordHash: '',
    handle: 'alice',
    deletedAt: null,
  };

  async function seededAlice(oldPassword: string) {
    const user = { ...ALICE, passwordHash: await hashPasswordReal(oldPassword) };
    return user;
  }

  function makeResetApp(
    authDb: NonNullable<ServerDeps['authDb']>,
    email = new CapturingEmailTransport(),
  ) {
    const app = buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
      authDb,
      email,
    });
    return { app, email };
  }

  it('forgot-password is 202 for an UNKNOWN email and mints no token (no enumeration)', async () => {
    const { db, resetTokens } = makePhase6Db({ users: [] });
    const { app, email } = makeResetApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: 'ghost@nowhere.io' },
    });
    expect(res.statusCode).toBe(202);
    expect(resetTokens).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
  });

  it('forgot-password is 202 for a KNOWN email and mints a single token + sends mail', async () => {
    const user = await seededAlice('oldpass123');
    const { db, resetTokens } = makePhase6Db({ users: [user] });
    const { app, email } = makeResetApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: user.email },
    });
    expect(res.statusCode).toBe(202);
    expect(resetTokens).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe(user.email);
    // The mailed body carries the raw token; the stored row carries only its hash.
    const body = email.sent[0]?.text ?? '';
    const stored = resetTokens[0]?.tokenHash ?? '';
    expect(stored).not.toBe('');
    // The body actually contains a token that hashes to the stored value (proves
    // the raw token is mailed but never persisted).
    const matches = body
      .split(/\s+/)
      .some((w) => createHash('sha256').update(w).digest('hex') === stored);
    expect(matches).toBe(true);
  });

  it('reset round-trip: old password fails, new succeeds, all sessions invalidated', async () => {
    const user = await seededAlice('oldpass123');
    const { db, resetTokens, sessions } = makePhase6Db({
      users: [user],
      sessions: [
        { token: 'sess1', userId: 'alice' },
        { token: 'sess2', userId: 'alice' },
      ],
    });
    const { app, email } = makeResetApp(db);

    // Mint a token via forgot-password and recover the raw token from the email body.
    await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: user.email },
    });
    const body = email.sent[0]?.text ?? '';
    // The raw token is the base64url string in the body; recover it by hashing
    // candidate tokens. Simpler: re-derive from the stored hash isn't possible, so
    // pull the token out of the body. It's the last whitespace-delimited token
    // that hashes to the stored value.
    const stored = resetTokens[0]?.tokenHash;
    const candidate = body
      .split(/\s+/)
      .find((w) => createHash('sha256').update(w).digest('hex') === stored);
    expect(candidate).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: candidate, newPassword: 'brandnew456' },
    });
    expect(res.statusCode).toBe(200);

    // Password actually changed: new verifies, old does not.
    expect(await verifyPasswordReal('brandnew456', user.passwordHash)).toBe(true);
    expect(await verifyPasswordReal('oldpass123', user.passwordHash)).toBe(false);
    // Every session was deleted (force re-login).
    expect(sessions).toHaveLength(0);
    // Token is now marked used.
    expect(resetTokens[0]?.usedAt).not.toBeNull();
  });

  it('reset rejects an unknown/garbage token with 400', async () => {
    const user = await seededAlice('oldpass123');
    const { db } = makePhase6Db({ users: [user] });
    const { app } = makeResetApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: 'not-a-real-token', newPassword: 'brandnew456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_or_expired_token' });
  });

  it('reset rejects an already-USED token with 400 (single-use)', async () => {
    const user = await seededAlice('oldpass123');
    const { db, resetTokens } = makePhase6Db({ users: [user] });
    const { app, email } = makeResetApp(db);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: user.email },
    });
    const body = email.sent[0]?.text ?? '';
    const stored = resetTokens[0]?.tokenHash;
    const candidate = body
      .split(/\s+/)
      .find((w) => createHash('sha256').update(w).digest('hex') === stored);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: candidate, newPassword: 'brandnew456' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: candidate, newPassword: 'another789' },
    });
    expect(second.statusCode).toBe(400);
  });

  it('reset rejects an EXPIRED token with 400', async () => {
    const user = await seededAlice('oldpass123');
    const { db, resetTokens } = makePhase6Db({ users: [user] });
    const { app } = makeResetApp(db);
    // Seed an expired token directly.
    const raw = 'expired-raw-token-value';
    resetTokens.push({
      id: 'tok_exp',
      userId: 'alice',
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: raw, newPassword: 'brandnew456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_or_expired_token' });
  });

  it('reset rejects a too-short new password with 400', async () => {
    const { db } = makePhase6Db({ users: [] });
    const { app } = makeResetApp(db);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: 'x', newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'password_too_short', min: 8 });
  });

  it('503 when authDb/email are not configured', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: 'a@b.io' },
    });
    expect(res.statusCode).toBe(503);
  });
});
