/**
 * Game Jam route tests. Everything runs through `fastify.inject()` against the
 * in-memory repos — no Postgres, no Redis, no browser.
 */
import { InMemoryEventBus } from '@playforge/bus';
import { JAM_MAX_PLAYERS, jamRoundPlan } from '@playforge/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeaderAuthenticator } from './auth';
import { InMemoryJamRepo } from './jam-repo';
import { InMemoryPublishRepo } from './publish-repo';
import { InMemoryProjectRepo } from './repo';
import { InMemoryRunRepo } from './run-repo';
import { type EnqueueFn, buildServer } from './server';

const AS_ALICE = { 'x-user-id': 'alice' };
const AS_BOB = { 'x-user-id': 'bob' };

function makeApp(over?: {
  jamRepo?: InMemoryJamRepo;
  bus?: InMemoryEventBus;
  enqueue?: EnqueueFn;
  repo?: InMemoryProjectRepo;
  publishRepo?: InMemoryPublishRepo;
}) {
  const jamRepo = over?.jamRepo ?? new InMemoryJamRepo();
  const repo = over?.repo ?? new InMemoryProjectRepo();
  const app = buildServer({
    repo,
    auth: new HeaderAuthenticator(),
    bus: over?.bus ?? new InMemoryEventBus(),
    runRepo: new InMemoryRunRepo(),
    enqueue: over?.enqueue ?? (async () => {}),
    jamRepo,
    ...(over?.publishRepo !== undefined ? { publishRepo: over.publishRepo } : {}),
  });
  return { app, jamRepo, repo };
}

/** Open a room and return the host's code + seat. */
async function hostJam(app: ReturnType<typeof makeApp>['app'], body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/jams',
    headers: AS_ALICE,
    payload: { name: 'Maya', ...body },
  });
  const json = res.json() as {
    state: { code: string; id: string };
    seat: { playerId: string; token: string };
  };
  return { code: json.state.code, jamId: json.state.id, seat: json.seat, res };
}

/** Join an existing room as a guest (no Authorization header at all). */
async function joinJam(app: ReturnType<typeof makeApp>['app'], code: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/jams/${code}/join`,
    payload: { name },
  });
  const json = res.json() as { seat?: { playerId: string; token: string } };
  return { res, seat: json.seat };
}

const seatHeaders = (token: string) => ({ 'x-jam-token': token });

describe('jam: hosting a room', () => {
  it('requires an account to open a room', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/v1/jams', payload: { name: 'Maya' } });
    expect(res.statusCode).toBe(401);
  });

  it('mints a 4-character code, seats the host, and hands back a seat token', async () => {
    const { app } = makeApp();
    const { res, code, seat } = await hostJam(app);
    expect(res.statusCode).toBe(201);
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    expect(seat.token.length).toBeGreaterThan(20);
    const state = (res.json() as { state: { players: Array<{ isHost: boolean; name: string }> } })
      .state;
    expect(state.players).toHaveLength(1);
    expect(state.players[0]).toMatchObject({ isHost: true, name: 'Maya' });
  });

  it('clamps the round count into the deck and defaults the engine', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jams',
      headers: AS_ALICE,
      payload: { name: 'Maya', rounds: 999, engine: 'unreal' },
    });
    const state = (
      res.json() as {
        state: { config: { rounds: number; engine: string }; roundPromptIds: string[] };
      }
    ).state;
    expect(state.config.rounds).toBe(10);
    expect(state.config.engine).toBe('phaser');
    expect(state.roundPromptIds).toHaveLength(10);
  });

  it('always plans the title card last so the game gets named', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jams',
      headers: AS_ALICE,
      payload: { name: 'Maya', rounds: 3 },
    });
    const ids = (res.json() as { state: { roundPromptIds: string[] } }).state.roundPromptIds;
    expect(ids).toHaveLength(3);
    expect(ids[2]).toBe('title');
  });

  it('rejects a blank host name', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jams',
      headers: AS_ALICE,
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists rooms the account hosted', async () => {
    const { app } = makeApp();
    await hostJam(app);
    const mine = await app.inject({ method: 'GET', url: '/v1/jams', headers: AS_ALICE });
    expect((mine.json() as { jams: unknown[] }).jams).toHaveLength(1);
    const theirs = await app.inject({ method: 'GET', url: '/v1/jams', headers: AS_BOB });
    expect((theirs.json() as { jams: unknown[] }).jams).toHaveLength(0);
  });
});

describe('jam: joining', () => {
  it('lets a signed-OUT guest join with just a name', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    const { res, seat } = await joinJam(app, code, 'Tobi');
    expect(res.statusCode).toBe(201);
    expect(seat?.token).toBeTruthy();
  });

  it('accepts a lowercase, spaced code the way a human types it', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    const spaced = `${code.slice(0, 2)} ${code.slice(2)}`.toLowerCase();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${encodeURIComponent(spaced)}/join`,
      payload: { name: 'Tobi' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('404s an unknown code', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jams/ZZZZ/join',
      payload: { name: 'T' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires a name', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    const res = await app.inject({ method: 'POST', url: `/v1/jams/${code}/join`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('assigns each new seat its own color', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    await joinJam(app, code, 'Tobi');
    await joinJam(app, code, 'Sam');
    const state = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const players = (state.json() as { state: { players: Array<{ color: string }> } }).state
      .players;
    expect(new Set(players.map((p) => p.color)).size).toBe(3);
  });

  it('refuses a 9th player', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    for (let i = 1; i < JAM_MAX_PLAYERS; i++) await joinJam(app, code, `P${i}`);
    const { res } = await joinJam(app, code, 'TooMany');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'jam_full' });
  });

  it('welcomes a late joiner mid-round but closes the door once building starts', async () => {
    const { app, jamRepo } = makeApp();
    const { code, jamId } = await hostJam(app);
    await joinJam(app, code, 'Tobi');
    await jamRepo.setPhase(jamId, 'prompt', { round: 0 });
    expect((await joinJam(app, code, 'Late')).res.statusCode).toBe(201);
    await jamRepo.setPhase(jamId, 'building');
    const shut = await joinJam(app, code, 'TooLate');
    expect(shut.res.statusCode).toBe(410);
  });

  it('hides an ended room entirely, freeing its code', async () => {
    const { app, jamRepo } = makeApp();
    const { code, jamId } = await hostJam(app);
    await jamRepo.end(jamId);
    const res = await joinJam(app, code, 'Tobi');
    expect(res.res.statusCode).toBe(404);
  });
});

describe('jam: seat auth', () => {
  it('rejects an action with no seat token', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    const res = await app.inject({ method: 'POST', url: `/v1/jams/${code}/start` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a seat token from a different room', async () => {
    const { app } = makeApp();
    const a = await hostJam(app);
    const b = await hostJam(app);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${b.code}/start`,
      headers: seatHeaders(a.seat.token),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses host-only actions from a guest seat', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    const guest = await joinJam(app, code, 'Tobi');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(guest.seat?.token ?? ''),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'jam_host_only' });
  });

  it('never returns a seat token to anyone but the joiner', async () => {
    const { app } = makeApp();
    const { code, seat } = await hostJam(app);
    const guest = await joinJam(app, code, 'Tobi');
    const view = await app.inject({
      method: 'GET',
      url: `/v1/jams/${code}`,
      headers: seatHeaders(guest.seat?.token ?? ''),
    });
    expect(view.body).not.toContain(seat.token);
    expect(view.body).not.toContain(guest.seat?.token ?? 'nope');
  });
});

describe('jam: playing rounds', () => {
  async function startedJam() {
    const { app, jamRepo, repo } = makeApp();
    const { code, jamId, seat } = await hostJam(app, { rounds: 3, answerSeconds: 0 });
    const guest = await joinJam(app, code, 'Tobi');
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(seat.token),
    });
    return { app, jamRepo, repo, code, jamId, host: seat, guest: guest.seat };
  }

  it('needs two players before it will start', async () => {
    const { app } = makeApp();
    const { code, seat } = await hostJam(app);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(seat.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'jam_needs_players' });
  });

  it('moves to the first prompt on start', async () => {
    const { app, code } = await startedJam();
    const state = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    expect((state.json() as { state: { phase: string; round: number } }).state).toMatchObject({
      phase: 'prompt',
      round: 0,
    });
  });

  it('sets a deadline only when the jam is timed', async () => {
    const timed = makeApp();
    const t = await hostJam(timed.app, { answerSeconds: 45 });
    await joinJam(timed.app, t.code, 'Tobi');
    await timed.app.inject({
      method: 'POST',
      url: `/v1/jams/${t.code}/start`,
      headers: seatHeaders(t.seat.token),
    });
    const state = await timed.app.inject({ method: 'GET', url: `/v1/jams/${t.code}` });
    expect(
      (state.json() as { state: { deadlineAt: number | null } }).state.deadlineAt,
    ).toBeGreaterThan(Date.now());

    const untimed = await startedJam();
    const u = await untimed.app.inject({ method: 'GET', url: `/v1/jams/${untimed.code}` });
    expect((u.json() as { state: { deadlineAt: number | null } }).state.deadlineAt).toBeNull();
  });

  it('accepts an idea and reports who has locked in without leaking the text', async () => {
    const { app, code, host, guest } = await startedJam();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(host.token),
      payload: { text: 'a sinking neon submarine' },
    });
    expect(res.statusCode).toBe(200);

    // The guest sees the progress pill but NOT the host's words.
    const view = await app.inject({
      method: 'GET',
      url: `/v1/jams/${code}`,
      headers: seatHeaders(guest?.token ?? ''),
    });
    const state = (
      view.json() as { state: { answeredPlayerIds: string[]; answers: Array<{ text: string }> } }
    ).state;
    expect(state.answeredPlayerIds).toContain(host.playerId);
    expect(state.answers).toHaveLength(0);
  });

  it('shows a player their OWN in-flight answer so a refresh is not confusing', async () => {
    const { app, code, host } = await startedJam();
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(host.token),
      payload: { text: 'a sinking neon submarine' },
    });
    const view = await app.inject({
      method: 'GET',
      url: `/v1/jams/${code}`,
      headers: seatHeaders(host.token),
    });
    const answers = (view.json() as { state: { answers: Array<{ text: string }> } }).state.answers;
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe('a sinking neon submarine');
  });

  it('edits rather than stacks when a player resubmits', async () => {
    const { app, code, host } = await startedJam();
    for (const text of ['first idea', 'better idea']) {
      await app.inject({
        method: 'POST',
        url: `/v1/jams/${code}/answer`,
        headers: seatHeaders(host.token),
        payload: { text },
      });
    }
    const view = await app.inject({
      method: 'GET',
      url: `/v1/jams/${code}`,
      headers: seatHeaders(host.token),
    });
    const answers = (view.json() as { state: { answers: Array<{ text: string }> } }).state.answers;
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe('better idea');
  });

  it('reveals automatically once the last player locks in', async () => {
    const { app, code, host, guest } = await startedJam();
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(host.token),
      payload: { text: 'a submarine' },
    });
    const last = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(guest?.token ?? ''),
      payload: { text: 'a haunted mall' },
    });
    expect(last.json()).toMatchObject({ revealed: true });

    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const state = (view.json() as { state: { phase: string; answers: unknown[] } }).state;
    expect(state.phase).toBe('reveal');
    expect(state.answers).toHaveLength(2);
  });

  it('lets the host cut a round short when someone stalls', async () => {
    const { app, code, host } = await startedJam();
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(host.token),
      payload: { text: 'a submarine' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/reveal`,
      headers: seatHeaders(host.token),
    });
    expect(res.statusCode).toBe(200);
    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    expect((view.json() as { state: { phase: string } }).state.phase).toBe('reveal');
  });

  it('refuses answers outside the prompt phase', async () => {
    const { app, code, host } = await startedJam();
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/reveal`,
      headers: seatHeaders(host.token),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(host.token),
      payload: { text: 'too late' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a blank idea', async () => {
    const { app, code, host } = await startedJam();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(host.token),
      payload: { text: '    ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('advances to the next card and clears the answered pill', async () => {
    const { app, code, host, guest } = await startedJam();
    for (const t of [host.token, guest?.token ?? '']) {
      await app.inject({
        method: 'POST',
        url: `/v1/jams/${code}/answer`,
        headers: seatHeaders(t),
        payload: { text: 'idea' },
      });
    }
    const next = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/next`,
      headers: seatHeaders(host.token),
    });
    expect(next.statusCode).toBe(200);
    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const state = (
      view.json() as { state: { phase: string; round: number; answeredPlayerIds: string[] } }
    ).state;
    expect(state).toMatchObject({ phase: 'prompt', round: 1 });
    expect(state.answeredPlayerIds).toEqual([]);
  });

  it('refuses to advance past the last card — that one builds', async () => {
    const { app, jamRepo, code, host, jamId } = await startedJam();
    const lastRound = jamRoundPlan(3).length - 1;
    await jamRepo.setPhase(jamId, 'reveal', { round: lastRound });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/next`,
      headers: seatHeaders(host.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'jam_rounds_complete' });
  });
});

describe('jam: hype votes', () => {
  async function revealedJam() {
    const { app, jamRepo, repo } = makeApp();
    const { code, jamId, seat } = await hostJam(app, { rounds: 3, answerSeconds: 0 });
    const guest = await joinJam(app, code, 'Tobi');
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(seat.token),
    });
    for (const [token, text] of [
      [seat.token, 'a sinking submarine'],
      [guest.seat?.token ?? '', 'a haunted mall'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: `/v1/jams/${code}/answer`,
        headers: seatHeaders(token),
        payload: { text },
      });
    }
    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const answers = (view.json() as { state: { answers: Array<{ id: string; playerId: string }> } })
      .state.answers;
    return { app, jamRepo, repo, code, jamId, host: seat, guest: guest.seat, answers };
  }

  it("counts a vote on someone else's idea", async () => {
    const { app, code, host, answers } = await revealedJam();
    const theirs = answers.find((a) => a.playerId !== host.playerId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/vote`,
      headers: seatHeaders(host.token),
      payload: { answerId: theirs?.id },
    });
    expect(res.json()).toMatchObject({ voted: true });

    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const after = (view.json() as { state: { answers: Array<{ id: string; votes: number }> } })
      .state.answers;
    expect(after.find((a) => a.id === theirs?.id)?.votes).toBe(1);
  });

  it('toggles a vote off on a second tap', async () => {
    const { app, code, host, answers } = await revealedJam();
    const theirs = answers.find((a) => a.playerId !== host.playerId);
    for (const expected of [true, false]) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/jams/${code}/vote`,
        headers: seatHeaders(host.token),
        payload: { answerId: theirs?.id },
      });
      expect(res.json()).toMatchObject({ voted: expected });
    }
  });

  it('refuses a self-vote so the ranking means something', async () => {
    const { app, code, host, answers } = await revealedJam();
    const mine = answers.find((a) => a.playerId === host.playerId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/vote`,
      headers: seatHeaders(host.token),
      payload: { answerId: mine?.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'jam_no_self_vote' });
  });

  it('404s an unknown answer id', async () => {
    const { app, code, host } = await revealedJam();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/vote`,
      headers: seatHeaders(host.token),
      payload: { answerId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses votes outside the reveal', async () => {
    const { app, jamRepo, jamId, code, host, answers } = await revealedJam();
    await jamRepo.setPhase(jamId, 'prompt', { round: 1 });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/vote`,
      headers: seatHeaders(host.token),
      payload: { answerId: answers[0]?.id },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('jam: building', () => {
  async function jamWithIdeas(enqueue?: EnqueueFn) {
    const bus = new InMemoryEventBus();
    const { app, jamRepo, repo } = makeApp({
      bus,
      ...(enqueue !== undefined ? { enqueue } : {}),
      publishRepo: new InMemoryPublishRepo(),
    });
    const { code, jamId, seat } = await hostJam(app, { rounds: 3, answerSeconds: 0 });
    const guest = await joinJam(app, code, 'Tobi');
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(seat.token),
    });
    // Round 0 (setting), then jump the room to the final (title) card.
    for (const [token, text] of [
      [seat.token, 'a sinking neon submarine'],
      [guest.seat?.token ?? '', 'rival vending machines'],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: `/v1/jams/${code}/answer`,
        headers: seatHeaders(token),
        payload: { text },
      });
    }
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/next`,
      headers: seatHeaders(seat.token),
    });
    return { app, jamRepo, repo, bus, code, jamId, host: seat, guest: guest.seat };
  }

  it('previews the compiled brief before any credits are spent', async () => {
    const { app, code, host } = await jamWithIdeas();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/jams/${code}/brief`,
      headers: seatHeaders(host.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      canBuild: boolean;
      brief: { prompt: string; playerCount: number };
    };
    expect(body.canBuild).toBe(true);
    expect(body.brief.playerCount).toBe(2);
    expect(body.brief.prompt).toContain('a sinking neon submarine');
    expect(body.brief.prompt).toContain('rival vending machines');
  });

  it('refuses to build a room with no ideas in it', async () => {
    const { app } = makeApp();
    const { code, seat } = await hostJam(app);
    await joinJam(app, code, 'Tobi');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(seat.token), ...AS_ALICE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'jam_not_ready' });
  });

  it('creates a project owned by the host and enqueues the compiled brief', async () => {
    const enqueue = vi.fn<EnqueueFn>(async () => {});
    const { app, code, host, repo } = await jamWithIdeas(enqueue);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(host.token), ...AS_ALICE },
    });
    expect(res.statusCode).toBe(202);
    const { projectId, runId } = res.json() as { projectId: string; runId: string };
    expect(runId).toBeTruthy();

    const project = await repo.get(projectId);
    expect(project?.ownerId).toBe('alice');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0]?.[0];
    expect(job?.userId).toBe('alice');
    expect(job?.prompt).toContain('LOCAL MULTIPLAYER game for 2 players');
    expect(job?.prompt).toContain('a sinking neon submarine');
  });

  it('flips the room to building and records the project + run', async () => {
    const { app, code, host } = await jamWithIdeas();
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(host.token), ...AS_ALICE },
    });
    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const state = (
      view.json() as { state: { phase: string; projectId: string | null; runId: string | null } }
    ).state;
    expect(state.phase).toBe('building');
    expect(state.projectId).toBeTruthy();
    expect(state.runId).toBeTruthy();
  });

  it('refuses a second build while one is in flight', async () => {
    const { app, code, host } = await jamWithIdeas();
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(host.token), ...AS_ALICE },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(host.token), ...AS_ALICE },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'jam_already_building' });
  });

  it('refuses a build from a guest seat', async () => {
    const { app, code, guest } = await jamWithIdeas();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(guest?.token ?? ''), ...AS_BOB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('flips the room to ready when the run completes', async () => {
    const { app, bus, code, host } = await jamWithIdeas();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(host.token), ...AS_ALICE },
    });
    const { runId } = res.json() as { runId: string };

    await bus.publish(`run:${runId}`, { type: 'run_complete', runId });
    // Let the watcher's async phase write settle.
    await new Promise((r) => setTimeout(r, 10));

    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    expect((view.json() as { state: { phase: string } }).state.phase).toBe('ready');
  });

  it('drops the room back to the reveal when a build fails, so they can retry', async () => {
    const { app, bus, code, host } = await jamWithIdeas();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/build`,
      headers: { ...seatHeaders(host.token), ...AS_ALICE },
    });
    const { runId } = res.json() as { runId: string };

    await bus.publish(`run:${runId}`, { type: 'run_error', runId, error: 'boom' });
    await new Promise((r) => setTimeout(r, 10));

    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    expect((view.json() as { state: { phase: string } }).state.phase).toBe('reveal');
  });
});

describe('jam: publishing for the room', () => {
  it('refuses before the game is built', async () => {
    const { app } = makeApp({ publishRepo: new InMemoryPublishRepo() });
    const { code, seat } = await hostJam(app);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/publish`,
      headers: { ...seatHeaders(seat.token), ...AS_ALICE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'jam_not_built' });
  });

  it('reads the slug back from the publish store rather than trusting the client', async () => {
    const publishRepo = new InMemoryPublishRepo();
    const { app, jamRepo, repo } = makeApp({ publishRepo });
    const { code, jamId, seat } = await hostJam(app);
    const project = await repo.create({ ownerId: 'alice', name: 'Crab Depth 9' });
    await jamRepo.attachBuild(jamId, project.id, 'run_1');
    await publishRepo.upsert({
      projectId: project.id,
      publishSlug: 'crab-depth-9',
      title: 'Crab Depth 9',
      bundleKey: 'blobs/abc',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/publish`,
      headers: { ...seatHeaders(seat.token), ...AS_ALICE },
      payload: { playSlug: 'attacker-chosen-slug' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ playSlug: 'crab-depth-9' });

    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    const state = (view.json() as { state: { playSlug: string | null; phase: string } }).state;
    expect(state.playSlug).toBe('crab-depth-9');
    expect(state.phase).toBe('ready');
  });

  it("refuses to publish another user's project into the room", async () => {
    const publishRepo = new InMemoryPublishRepo();
    const { app, jamRepo, repo } = makeApp({ publishRepo });
    const { code, jamId, seat } = await hostJam(app);
    const bobsProject = await repo.create({ ownerId: 'bob', name: 'Not Yours' });
    await jamRepo.attachBuild(jamId, bobsProject.id, 'run_1');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/publish`,
      headers: { ...seatHeaders(seat.token), ...AS_ALICE },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('jam: leaving and ending', () => {
  it('drops a player from the roster but keeps their idea in the brief', async () => {
    const { app } = makeApp();
    const { code, seat } = await hostJam(app, { rounds: 3, answerSeconds: 0 });
    const guest = await joinJam(app, code, 'Tobi');
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(seat.token),
    });
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/answer`,
      headers: seatHeaders(guest.seat?.token ?? ''),
      payload: { text: 'angry crabs' },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/leave`,
      headers: seatHeaders(guest.seat?.token ?? ''),
    });

    const brief = await app.inject({
      method: 'GET',
      url: `/v1/jams/${code}/brief`,
      headers: seatHeaders(seat.token),
    });
    const body = brief.json() as { brief: { prompt: string } };
    expect(body.brief.prompt).toContain('angry crabs');

    const view = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    expect((view.json() as { state: { players: unknown[] } }).state.players).toHaveLength(1);
  });

  it('invalidates the seat token once a player leaves', async () => {
    const { app } = makeApp();
    const { code } = await hostJam(app);
    const guest = await joinJam(app, code, 'Tobi');
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/leave`,
      headers: seatHeaders(guest.seat?.token ?? ''),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/leave`,
      headers: seatHeaders(guest.seat?.token ?? ''),
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets the host close the room, freeing the code', async () => {
    const { app } = makeApp();
    const { code, seat } = await hostJam(app);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/end`,
      headers: seatHeaders(seat.token),
    });
    expect(res.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: `/v1/jams/${code}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe('jam: disabled deployment', () => {
  it('404s the whole surface when no jam store is wired', async () => {
    const app = buildServer({
      repo: new InMemoryProjectRepo(),
      auth: new HeaderAuthenticator(),
      bus: new InMemoryEventBus(),
      runRepo: new InMemoryRunRepo(),
      enqueue: async () => {},
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jams',
      headers: AS_ALICE,
      payload: { name: 'Maya' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('jam: multi-instance fan-out', () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  it('nudges the shared bus on every mutation so other API instances refresh', async () => {
    const { app } = makeApp({ bus });
    const seen: unknown[] = [];
    const { code, jamId, seat } = await hostJam(app);
    await bus.subscribe(`jam:${jamId}`, (m) => seen.push(m), { replay: false });

    await joinJam(app, code, 'Tobi');
    await app.inject({
      method: 'POST',
      url: `/v1/jams/${code}/start`,
      headers: seatHeaders(seat.token),
    });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toMatchObject({ type: 'jam_dirty', jamId });
  });
});
