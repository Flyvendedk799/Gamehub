/**
 * Game Jam — the party-mode HTTP + WebSocket surface.
 *
 * A jam is a live room: 2–8 people join from their phones with a four-character
 * code, answer prompt cards round by round, hype each other's ideas, and then
 * the host compiles the whole pile into ONE brief that goes through the normal
 * generation pipeline (`startGeneration`) and comes back as a real, playable
 * couch-co-op game.
 *
 * Lives in its own module rather than inside buildServer's closure because the
 * surface is large and self-contained; everything it needs from the server is
 * passed in `JamRouteContext`.
 *
 * ## Two identities, deliberately
 * - **Seat token** (`x-jam-token`) — who you are IN THE ROOM. Guests get one at
 *   join with no account. It authorizes answering, voting and reading the room,
 *   and nothing else, anywhere.
 * - **Session token** (`Authorization`) — who you are on the platform. Required
 *   only where the platform is on the hook: opening a room and building
 *   (the host's account owns the project and their credits pay for the run).
 *
 * A host action therefore checks BOTH: the seat proves you're the host of this
 * room, the session proves you're the account that opened it.
 *
 * ## Fan-out
 * Every mutation re-reads the room and broadcasts the full state to connected
 * sockets, and publishes a nudge on the shared event bus so sockets attached to
 * OTHER API instances refresh too — a party is exactly the case where players
 * land on different instances behind a load balancer. State is small (a room is
 * a few KB), so full-snapshot broadcast beats a patch protocol here: there is no
 * client-side merge to get wrong, and a reconnecting phone is instantly correct.
 */
import {
  JAM_MAX_ANSWER_LEN,
  JAM_MAX_NAME_LEN,
  JAM_MAX_ROUNDS,
  JAM_MIN_PLAYERS,
  JAM_MIN_ROUNDS,
  type JamConfig,
  type JamEngine,
  type JamPhase,
  type JamState,
  canCompileJam,
  compileJamBrief,
  jamChannel,
  jamPromptById,
  normalizeJamCode,
  redactJamState,
  sanitizeJamAnswer,
  sanitizeJamName,
} from '@playforge/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthedUser } from './auth';
import type { JamRepo } from './jam-repo';
import type { PublishRepo } from './publish-repo';
import type { Engine, Project, ProjectRepo } from './repo';

/** A room socket: the seat watching, and how to push it a frame. */
interface JamSocketEntry {
  playerId: string | null;
  send(payload: unknown): void;
}

/** Minimal shape of the ws socket objects fastify hands us. */
export interface JamWebSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  on(event: 'message' | 'close' | 'error', listener: (...args: never[]) => void): void;
}

export interface JamRouteContext {
  jamRepo: JamRepo;
  projectRepo: ProjectRepo;
  publishRepo?: PublishRepo | undefined;
  bus: {
    publish(channel: string, message: unknown): Promise<void>;
    subscribe(
      channel: string,
      handler: (message: unknown) => void,
      opts?: { replay?: boolean },
    ): Promise<() => void>;
  };
  /** Resolve the platform session on a request (null when unauthenticated). */
  authenticate(req: FastifyRequest): Promise<AuthedUser | null>;
  /** Shared generation entry point — same run cap + credit path as /generate. */
  startGeneration(
    project: Project,
    userId: string,
    prompt: string,
  ): Promise<{ ok: true; runId: string } | { ok: false; status: number; body: unknown }>;
  /** Create the project a finished jam builds into. */
  createProject(input: { ownerId: string; name: string; engine: Engine }): Promise<Project>;
  /**
   * Terminal state of the jam's run, for healing a room stuck in `building`.
   * The room normally learns a build finished from the bus watcher, but that
   * watcher lives in one API process: restart it, or route the room to a
   * different instance, and nobody is listening. Without this the party stares
   * at a spinner forever for a game that finished minutes ago.
   */
  getRunStatus?: (runId: string) => Promise<string | null>;
  /** Wall clock, injectable so timer behaviour is testable. */
  now?: () => number;
}

/**
 * Rooms with at least one socket attached to THIS instance.
 * jamId → sockets, plus the bus unsubscribe for that room.
 */
interface LiveRoom {
  sockets: Set<JamSocketEntry>;
  unsubscribe: (() => void) | null;
}

/** Turn a raw path segment into a room code, or null when it can't be one. */
function parseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = normalizeJamCode(decodeURIComponent(raw));
  return code.length > 0 ? code : null;
}

export function registerJamRoutes(app: FastifyInstance, ctx: JamRouteContext): void {
  const now = ctx.now ?? (() => Date.now());
  const rooms = new Map<string, LiveRoom>();

  // ── fan-out ───────────────────────────────────────────────────────────────

  /**
   * Push the current room to every socket attached HERE, redacting per viewer so
   * an in-flight round's answers never reach the wrong phone. Each socket gets
   * its own view — the redaction is per-seat, not per-room.
   */
  async function broadcastLocal(jamId: string): Promise<void> {
    const room = rooms.get(jamId);
    if (!room || room.sockets.size === 0) return;
    const state = await ctx.jamRepo.getState(jamId);
    if (!state) return;
    const live = withConnected(state, room.sockets);
    for (const entry of room.sockets) {
      entry.send({ type: 'jam_state', state: redactJamState(live, entry.playerId) });
    }
  }

  /**
   * Announce a change: refresh local sockets now, and nudge other API instances
   * over the bus so their sockets refresh too. `replay: false` on the subscribe
   * side keeps a late-joining room from replaying every past nudge.
   */
  async function announce(jamId: string): Promise<void> {
    await broadcastLocal(jamId);
    await ctx.bus.publish(jamChannel(jamId), { type: 'jam_dirty', jamId }).catch(() => {});
  }

  /** Push a transient toast (someone joined, an idea landed) to local sockets. */
  function toastLocal(
    jamId: string,
    kind: 'join' | 'leave' | 'answer' | 'vote' | 'phase' | 'error',
    message: string,
    playerId: string | null = null,
  ): void {
    const room = rooms.get(jamId);
    if (!room) return;
    for (const entry of room.sockets) entry.send({ type: 'jam_toast', kind, message, playerId });
  }

  /** Overlay live-socket liveness onto the roster the repo returned. */
  function withConnected(state: JamState, sockets: Set<JamSocketEntry>): JamState {
    const online = new Set<string>();
    for (const s of sockets) if (s.playerId) online.add(s.playerId);
    return {
      ...state,
      players: state.players.map((p) => ({ ...p, connected: online.has(p.id) })),
    };
  }

  /** The room's view for a REST reply — same redaction as the socket path. */
  function viewFor(state: JamState, playerId: string | null): JamState {
    const sockets = rooms.get(state.id)?.sockets ?? new Set<JamSocketEntry>();
    return redactJamState(withConnected(state, sockets), playerId);
  }

  // ── seat resolution ───────────────────────────────────────────────────────

  interface SeatContext {
    jamId: string;
    state: JamState;
    playerId: string;
    isHost: boolean;
  }

  function seatTokenOf(req: FastifyRequest): string | null {
    const header = req.headers['x-jam-token'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
    const q = (req.query as { jamToken?: unknown } | undefined)?.jamToken;
    return typeof q === 'string' && q.length > 0 ? q : null;
  }

  /**
   * Heal a room whose real state has drifted from its stored phase, and return
   * the corrected snapshot.
   *
   * Two things can strand a party, and neither is worth a scheduler:
   *
   *  - **An expired round.** The answer deadline passes while the host is
   *    holding a drink. Rather than a timer job we expire LAZILY: the next time
   *    anyone touches the room — and every client polls — the round flips to the
   *    reveal. Clients also refresh the moment their countdown hits zero, so in
   *    practice the room turns over within a second of the deadline.
   *  - **A finished build nobody heard about.** The bus watcher that flips
   *    `building` → `ready` lives in one process; restart it and the room waits
   *    forever. Reading the run's own status closes that hole.
   *
   * Idempotent and cheap: it compares, and only writes when a transition is
   * genuinely due, so running it on every request costs nothing in steady state.
   */
  async function reconcileRoom(jamId: string, state: JamState): Promise<JamState> {
    if (state.phase === 'prompt' && state.deadlineAt !== null && state.deadlineAt <= now()) {
      await ctx.jamRepo.setPhase(jamId, 'reveal', { deadlineAt: null });
      toastLocal(jamId, 'phase', "Time's up");
      const fresh = await ctx.jamRepo.getState(jamId);
      if (fresh) {
        await announce(jamId);
        return fresh;
      }
    }

    if (state.phase === 'building' && state.runId !== null && ctx.getRunStatus) {
      const status = await ctx.getRunStatus(state.runId).catch(() => null);
      // `paused` stays in `building` — a paused run is resumable, and bouncing
      // the room out of the build screen would read as failure.
      const settled =
        status === 'completed'
          ? 'ready'
          : status === 'failed' || status === 'canceled'
            ? 'reveal'
            : null;
      if (settled !== null) {
        await ctx.jamRepo.setPhase(jamId, settled);
        toastLocal(
          jamId,
          'phase',
          settled === 'ready' ? 'Your game is ready' : 'The build failed — try again',
        );
        const fresh = await ctx.jamRepo.getState(jamId);
        if (fresh) {
          await announce(jamId);
          return fresh;
        }
      }
    }

    return state;
  }

  /** Resolve `:code` to a live room, or reply 404. */
  async function requireRoom(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ jamId: string; state: JamState } | null> {
    const code = parseCode((req.params as { code?: unknown }).code);
    if (!code) {
      await reply.code(404).send({ error: 'jam_not_found' });
      return null;
    }
    const jamId = await ctx.jamRepo.findLiveIdByCode(code);
    if (!jamId) {
      await reply.code(404).send({ error: 'jam_not_found' });
      return null;
    }
    const state = await ctx.jamRepo.getState(jamId);
    if (!state) {
      await reply.code(404).send({ error: 'jam_not_found' });
      return null;
    }
    return { jamId, state: await reconcileRoom(jamId, state) };
  }

  /** Resolve `:code` + the seat token, or reply 404/401. */
  async function requireSeat(
    req: FastifyRequest,
    reply: FastifyReply,
    opts?: { host?: boolean },
  ): Promise<SeatContext | null> {
    const room = await requireRoom(req, reply);
    if (!room) return null;
    const token = seatTokenOf(req);
    if (!token) {
      await reply.code(401).send({ error: 'jam_seat_required' });
      return null;
    }
    const player = await ctx.jamRepo.resolveSeat(room.jamId, token);
    if (!player) {
      await reply.code(401).send({ error: 'jam_seat_invalid' });
      return null;
    }
    const isHost = player.id === room.state.hostPlayerId;
    if (opts?.host === true && !isHost) {
      await reply.code(403).send({ error: 'jam_host_only' });
      return null;
    }
    return { jamId: room.jamId, state: room.state, playerId: player.id, isHost };
  }

  // ── round helpers ─────────────────────────────────────────────────────────

  /** Prompt id for a round index, or null past the end of the plan. */
  function promptIdFor(state: JamState, round: number): string | null {
    return state.roundPromptIds[round] ?? null;
  }

  /** Deadline (epoch ms) for a fresh prompt round; null when the jam is untimed. */
  function deadlineFor(config: JamConfig): number | null {
    return config.answerSeconds > 0 ? now() + config.answerSeconds * 1000 : null;
  }

  /** Has every seated player answered the current round? */
  function everyoneAnswered(state: JamState): boolean {
    if (state.players.length === 0) return false;
    const answered = new Set(state.answeredPlayerIds);
    return state.players.every((p) => answered.has(p.id));
  }

  /** Is this the last card in the plan? Then `next` builds instead of advancing. */
  function isFinalRound(state: JamState): boolean {
    return state.round >= state.roundPromptIds.length - 1;
  }

  /**
   * Who inherits the room when the host leaves.
   *
   * Prefers a SIGNED-IN player: building creates a project and spends credits,
   * so only an account holder can actually finish the jam. Falling back to a
   * guest still beats leaving nobody in charge — they can run the rounds, and
   * the build button tells them to sign in — but an account holder means the
   * room can go all the way through without anyone noticing the handoff.
   */
  function pickHeir(state: JamState, leavingPlayerId: string): JamState['players'][number] | null {
    const remaining = state.players
      .filter((p) => p.id !== leavingPlayerId)
      .sort((a, b) => a.seat - b.seat);
    return remaining.find((p) => p.userId !== null) ?? remaining[0] ?? null;
  }

  // ── routes ────────────────────────────────────────────────────────────────

  /** Open a room. Host must be signed in — their account owns the built game. */
  app.post('/v1/jams', async (req, reply) => {
    const user = await ctx.authenticate(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });

    const body = (req.body ?? {}) as {
      name?: unknown;
      rounds?: unknown;
      engine?: unknown;
      answerSeconds?: unknown;
    };

    const hostName = sanitizeJamName(typeof body.name === 'string' ? body.name : 'Host');
    if (hostName === '') return reply.code(400).send({ error: 'name_required' });

    const rounds =
      typeof body.rounds === 'number' && Number.isFinite(body.rounds)
        ? Math.min(JAM_MAX_ROUNDS, Math.max(JAM_MIN_ROUNDS, Math.floor(body.rounds)))
        : 6;
    const engine: JamEngine = body.engine === 'three' ? 'three' : 'phaser';
    const answerSeconds =
      typeof body.answerSeconds === 'number' && Number.isFinite(body.answerSeconds)
        ? Math.min(300, Math.max(0, Math.floor(body.answerSeconds)))
        : 60;

    const { state, seat } = await ctx.jamRepo.create({
      hostUserId: user.userId,
      hostName,
      config: { rounds, engine, answerSeconds },
    });
    return reply.code(201).send({ state: viewFor(state, seat.playerId), seat });
  });

  /** Rooms this account hosted, newest first. */
  app.get('/v1/jams', async (req, reply) => {
    const user = await ctx.authenticate(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.send({ jams: await ctx.jamRepo.listByHost(user.userId) });
  });

  /**
   * Read a room. A seat token is optional: someone holding the code can see the
   * lobby before they pick a name. Redaction still applies, so a code-holder who
   * is not seated never sees an in-flight round's answers.
   */
  app.get('/v1/jams/:code', async (req, reply) => {
    const room = await requireRoom(req, reply);
    if (!room) return;
    const token = seatTokenOf(req);
    const player = token ? await ctx.jamRepo.resolveSeat(room.jamId, token) : null;
    return reply.send({ state: viewFor(room.state, player?.id ?? null), you: player?.id ?? null });
  });

  /** Join by code. Auth OPTIONAL — a guest with a phone is the common case. */
  app.post('/v1/jams/:code/join', async (req, reply) => {
    const room = await requireRoom(req, reply);
    if (!room) return;

    const body = (req.body ?? {}) as { name?: unknown };
    const name = sanitizeJamName(typeof body.name === 'string' ? body.name : '');
    if (name === '') {
      return reply.code(400).send({ error: 'name_required', max: JAM_MAX_NAME_LEN });
    }

    // A signed-in joiner is linked to their account (so a jam shows up in their
    // history); a guest is not. Either way the SEAT is what authorizes them.
    const user = await ctx.authenticate(req);
    const result = await ctx.jamRepo.join(room.jamId, {
      name,
      userId: user?.userId ?? null,
    });
    if ('error' in result) {
      return reply
        .code(result.error === 'full' ? 409 : 410)
        .send({ error: result.error === 'full' ? 'jam_full' : 'jam_closed' });
    }

    const state = await ctx.jamRepo.getState(room.jamId);
    toastLocal(room.jamId, 'join', `${name} joined`, result.seat.playerId);
    await announce(room.jamId);
    return reply.code(201).send({
      state: state ? viewFor(state, result.seat.playerId) : room.state,
      seat: result.seat,
    });
  });

  /** Host starts the jam: lobby → first prompt card. */
  app.post('/v1/jams/:code/start', async (req, reply) => {
    const seat = await requireSeat(req, reply, { host: true });
    if (!seat) return;
    if (seat.state.phase !== 'lobby') {
      return reply.code(409).send({ error: 'jam_already_started', phase: seat.state.phase });
    }
    if (seat.state.players.length < JAM_MIN_PLAYERS) {
      return reply.code(409).send({ error: 'jam_needs_players', min: JAM_MIN_PLAYERS });
    }
    await ctx.jamRepo.setPhase(seat.jamId, 'prompt', {
      round: 0,
      deadlineAt: deadlineFor(seat.state.config),
    });
    toastLocal(seat.jamId, 'phase', 'Jam started');
    await announce(seat.jamId);
    return reply.send({ ok: true });
  });

  /**
   * Submit (or edit) this seat's idea for the current round. When the last
   * player locks in, the room flips to the reveal on its own — nobody should
   * have to wait on the host to press a button they can't see.
   */
  app.post('/v1/jams/:code/answer', async (req, reply) => {
    const seat = await requireSeat(req, reply);
    if (!seat) return;
    if (seat.state.phase !== 'prompt') {
      return reply.code(409).send({ error: 'jam_not_accepting_answers', phase: seat.state.phase });
    }
    const body = (req.body ?? {}) as { text?: unknown };
    const text = sanitizeJamAnswer(typeof body.text === 'string' ? body.text : '');
    if (text === '') {
      return reply.code(400).send({ error: 'answer_required', max: JAM_MAX_ANSWER_LEN });
    }
    const promptId = promptIdFor(seat.state, seat.state.round);
    if (!promptId || !jamPromptById(promptId)) {
      return reply.code(409).send({ error: 'jam_round_invalid' });
    }

    await ctx.jamRepo.submitAnswer({
      jamId: seat.jamId,
      playerId: seat.playerId,
      round: seat.state.round,
      promptId,
      text,
    });

    const after = await ctx.jamRepo.getState(seat.jamId);
    let autoRevealed = false;
    if (after && after.phase === 'prompt' && everyoneAnswered(after)) {
      await ctx.jamRepo.setPhase(seat.jamId, 'reveal', { deadlineAt: null });
      autoRevealed = true;
    }
    toastLocal(seat.jamId, 'answer', 'Idea locked in', seat.playerId);
    if (autoRevealed) toastLocal(seat.jamId, 'phase', 'Everyone is in');
    await announce(seat.jamId);
    return reply.send({ ok: true, revealed: autoRevealed });
  });

  /** Host cuts the round short — reveal what's in, even if someone stalled. */
  app.post('/v1/jams/:code/reveal', async (req, reply) => {
    const seat = await requireSeat(req, reply, { host: true });
    if (!seat) return;
    if (seat.state.phase !== 'prompt') {
      return reply.code(409).send({ error: 'jam_not_in_prompt', phase: seat.state.phase });
    }
    await ctx.jamRepo.setPhase(seat.jamId, 'reveal', { deadlineAt: null });
    toastLocal(seat.jamId, 'phase', 'Time! Here they are');
    await announce(seat.jamId);
    return reply.send({ ok: true });
  });

  /** Hype an idea during the reveal. Toggles, and never counts your own. */
  app.post('/v1/jams/:code/vote', async (req, reply) => {
    const seat = await requireSeat(req, reply);
    if (!seat) return;
    if (seat.state.phase !== 'reveal') {
      return reply.code(409).send({ error: 'jam_not_in_reveal', phase: seat.state.phase });
    }
    const body = (req.body ?? {}) as { answerId?: unknown };
    if (typeof body.answerId !== 'string') {
      return reply.code(400).send({ error: 'answer_id_required' });
    }
    const target = seat.state.answers.find((a) => a.id === body.answerId);
    if (!target) return reply.code(404).send({ error: 'answer_not_found' });
    // Self-votes would make the reveal ranking meaningless — everyone would top
    // their own card and the compiled brief would lose its ordering signal.
    if (target.playerId === seat.playerId) {
      return reply.code(409).send({ error: 'jam_no_self_vote' });
    }

    const voted = await ctx.jamRepo.toggleVote(seat.jamId, target.id, seat.playerId);
    if (voted) toastLocal(seat.jamId, 'vote', 'Hyped', seat.playerId);
    await announce(seat.jamId);
    return reply.send({ ok: true, voted });
  });

  /** Host advances to the next card. Refused on the last one — that one builds. */
  app.post('/v1/jams/:code/next', async (req, reply) => {
    const seat = await requireSeat(req, reply, { host: true });
    if (!seat) return;
    if (seat.state.phase !== 'reveal') {
      return reply.code(409).send({ error: 'jam_not_in_reveal', phase: seat.state.phase });
    }
    if (isFinalRound(seat.state)) {
      return reply.code(409).send({ error: 'jam_rounds_complete' });
    }
    await ctx.jamRepo.setPhase(seat.jamId, 'prompt', {
      round: seat.state.round + 1,
      deadlineAt: deadlineFor(seat.state.config),
    });
    toastLocal(seat.jamId, 'phase', 'Next question');
    await announce(seat.jamId);
    return reply.send({ ok: true });
  });

  /**
   * Preview the compiled brief. The host sees exactly what the agent will read
   * before they spend a build on it — a jam that produced nonsense is worth
   * seeing BEFORE the credits go.
   */
  app.get('/v1/jams/:code/brief', async (req, reply) => {
    const seat = await requireSeat(req, reply);
    if (!seat) return;
    const brief = compileJamBrief(seat.state);
    return reply.send({ brief, canBuild: canCompileJam(seat.state) });
  });

  /**
   * Compile the room and build it. Host-only, and the host must also be the
   * signed-in account that opened the room: their project, their credits.
   */
  app.post('/v1/jams/:code/build', async (req, reply) => {
    const seat = await requireSeat(req, reply, { host: true });
    if (!seat) return;
    const user = await ctx.authenticate(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });

    if (seat.state.phase === 'building') {
      return reply.code(409).send({ error: 'jam_already_building' });
    }
    if (!canCompileJam(seat.state)) {
      return reply.code(409).send({ error: 'jam_not_ready', min: JAM_MIN_PLAYERS });
    }

    const brief = compileJamBrief(seat.state);
    // 'three' is the jam-facing spelling; the project repo's engine union
    // spells the same engine 'three' as well, so this maps 1:1 today — kept
    // explicit so a future divergence is a compile error, not a silent bug.
    const engine: Engine = brief.engine === 'three' ? 'three' : 'phaser';
    const project = await ctx.createProject({
      ownerId: user.userId,
      name: brief.name,
      engine,
    });

    const started = await ctx.startGeneration(project, user.userId, brief.prompt);
    if (!started.ok) return reply.code(started.status).send(started.body);

    await ctx.jamRepo.attachBuild(seat.jamId, project.id, started.runId);
    await ctx.jamRepo.setPhase(seat.jamId, 'building', { deadlineAt: null });
    toastLocal(seat.jamId, 'phase', 'Building your game');
    await announce(seat.jamId);
    watchBuild(seat.jamId, started.runId);
    return reply.code(202).send({ projectId: project.id, runId: started.runId });
  });

  /**
   * Publish the built game so the WHOLE ROOM can play it.
   *
   * Guests have no account and cannot read `/v1/projects/:id`, so a public play
   * slug is the only link that works for everyone holding a phone. The host
   * publishes through the normal `POST /v1/projects/:id/publish` route first
   * (publishing is outward-facing, so it stays an explicit, owner-authenticated
   * action) and then calls this, which reads the slug back from the publish
   * store BY PROJECT ID — the client never gets to name the slug.
   */
  app.post('/v1/jams/:code/publish', async (req, reply) => {
    const seat = await requireSeat(req, reply, { host: true });
    if (!seat) return;
    const user = await ctx.authenticate(req);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    if (!ctx.publishRepo) return reply.code(503).send({ error: 'publish_unavailable' });
    if (!seat.state.projectId) return reply.code(409).send({ error: 'jam_not_built' });

    const project = await ctx.projectRepo.get(seat.state.projectId);
    if (!project || project.ownerId !== user.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const published = await ctx.publishRepo.getByProject(project.id);
    if (!published || published.status !== 'live') {
      return reply.code(409).send({ error: 'jam_game_not_published' });
    }

    await ctx.jamRepo.setPlaySlug(seat.jamId, published.publishSlug);
    await ctx.jamRepo.setPhase(seat.jamId, 'ready');
    toastLocal(seat.jamId, 'phase', 'Ready to play');
    await announce(seat.jamId);
    return reply.send({ playSlug: published.publishSlug });
  });

  /** Leave the room. Your ideas stay — a jam records what the room made. */
  app.post('/v1/jams/:code/leave', async (req, reply) => {
    const seat = await requireSeat(req, reply);
    if (!seat) return;
    const leaver = seat.state.players.find((p) => p.id === seat.playerId);
    await ctx.jamRepo.leave(seat.jamId, seat.playerId);

    // Start / next / build are all host-only, so a host who walks out would
    // otherwise leave everyone else stuck in a room nobody can advance. Hand it
    // to whoever is still here.
    if (seat.isHost) {
      const heir = pickHeir(seat.state, seat.playerId);
      if (heir) {
        await ctx.jamRepo.transferHost(seat.jamId, heir.id);
        toastLocal(seat.jamId, 'phase', `${heir.name} is the host now`, heir.id);
      }
    }

    toastLocal(seat.jamId, 'leave', `${leaver?.name ?? 'Someone'} left`, seat.playerId);
    await announce(seat.jamId);
    return reply.send({ ok: true });
  });

  /** Host closes the room, freeing its code for the next party. */
  app.post('/v1/jams/:code/end', async (req, reply) => {
    const seat = await requireSeat(req, reply, { host: true });
    if (!seat) return;
    await ctx.jamRepo.end(seat.jamId);
    toastLocal(seat.jamId, 'phase', 'Jam closed');
    await announce(seat.jamId);
    return reply.send({ ok: true });
  });

  // ── build watcher ─────────────────────────────────────────────────────────

  /** Rooms currently tailing a run, so a double build can't double-subscribe. */
  const buildWatchers = new Map<string, () => void>();

  /**
   * Tail the run's event channel and relay a HUMAN-readable line to the room,
   * then flip the room to `ready` when the build lands.
   *
   * Guests can't open the run's SSE stream (that route is owner-only, correctly
   * so), and "watch it build together" is half the fun of a jam — so the room
   * socket is their window. We forward only a short label per event, never the
   * raw agent transcript: a party doesn't want a build log, it wants a heartbeat.
   */
  function watchBuild(jamId: string, runId: string): void {
    buildWatchers.get(jamId)?.();
    buildWatchers.delete(jamId);

    void ctx.bus
      .subscribe(
        `run:${runId}`,
        (message: unknown) => {
          const evt = message as { type?: unknown; label?: unknown; toolName?: unknown } | null;
          const type = typeof evt?.type === 'string' ? evt.type : '';
          if (type === 'run_complete') {
            void finishBuild(jamId, 'ready', 'Your game is ready');
            return;
          }
          if (type === 'run_error') {
            void finishBuild(jamId, 'reveal', 'The build failed — try again');
            return;
          }
          const label =
            typeof evt?.label === 'string'
              ? evt.label
              : typeof evt?.toolName === 'string'
                ? evt.toolName
                : null;
          if (label) toastLocal(jamId, 'phase', label);
        },
        // Live-only: a room joining mid-build must not replay the whole run.
        { replay: false },
      )
      .then((unsubscribe) => {
        buildWatchers.set(jamId, unsubscribe);
      })
      .catch((err: unknown) => {
        console.warn(`[jam:${jamId}] could not watch run ${runId}:`, err);
      });
  }

  /** Settle a watched build: set the room's phase, toast, and stop tailing. */
  async function finishBuild(jamId: string, phase: JamPhase, message: string): Promise<void> {
    buildWatchers.get(jamId)?.();
    buildWatchers.delete(jamId);
    await ctx.jamRepo.setPhase(jamId, phase).catch(() => {});
    toastLocal(jamId, 'phase', message);
    await announce(jamId).catch(() => {});
  }

  // ── room socket ───────────────────────────────────────────────────────────

  app.after(() => {
    /**
     * The room's live channel. One frame type matters (`jam_state`, the full
     * redacted snapshot); toasts ride alongside for the animations. Clients that
     * cannot hold a socket open fall back to polling `GET /v1/jams/:code`, which
     * returns the identical view — no feature depends on the socket.
     */
    app.get('/v1/jams/:code/room', { websocket: true }, async (first: unknown, second: unknown) => {
      const socket = (
        isJamSocket(first) ? first : isJamSocket(second) ? second : null
      ) as JamWebSocket | null;
      const req = (
        isFastifyish(second) ? second : isFastifyish(first) ? first : null
      ) as FastifyRequest | null;
      if (!socket || !req) return;

      const code =
        parseCode((req.params as { code?: unknown } | undefined)?.code) ?? codeFromUrl(req.url);
      if (!code) {
        socket.close(1008, 'invalid_code');
        return;
      }
      const jamId = await ctx.jamRepo.findLiveIdByCode(code);
      if (!jamId) {
        socket.close(1008, 'jam_not_found');
        return;
      }
      // A seat token is optional here so a phone can watch the lobby while its
      // owner is still typing a name; redaction keys off the resolved seat, so a
      // spectator never sees an in-flight round.
      const token = seatTokenOf(req);
      const player = token ? await ctx.jamRepo.resolveSeat(jamId, token) : null;

      const entry: JamSocketEntry = {
        playerId: player?.id ?? null,
        send(payload) {
          try {
            socket.send(JSON.stringify(payload));
          } catch {
            /* disconnected */
          }
        },
      };

      let room = rooms.get(jamId);
      if (!room) {
        room = { sockets: new Set(), unsubscribe: null };
        rooms.set(jamId, room);
        // First socket for this room on this instance: start listening for
        // nudges from the others. Live-only — a fresh room must not replay.
        void ctx.bus
          .subscribe(jamChannel(jamId), () => void broadcastLocal(jamId), { replay: false })
          .then((unsubscribe) => {
            const current = rooms.get(jamId);
            // The room may have emptied while we were subscribing; don't leak.
            if (current) current.unsubscribe = unsubscribe;
            else unsubscribe();
          })
          .catch(() => {});
      }
      room.sockets.add(entry);

      // Send the snapshot immediately — a phone that just woke up is correct
      // before it renders a frame.
      void broadcastLocal(jamId);

      socket.on('close', () => {
        const current = rooms.get(jamId);
        if (!current) return;
        current.sockets.delete(entry);
        if (current.sockets.size === 0) {
          current.unsubscribe?.();
          rooms.delete(jamId);
        } else {
          // Someone's dot just went grey — tell the rest of the room.
          void broadcastLocal(jamId);
        }
      });
    });
  });

  /** Structural check for the ws socket object fastify passes. */
  function isJamSocket(value: unknown): value is JamWebSocket {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { send?: unknown }).send === 'function' &&
      typeof (value as { close?: unknown }).close === 'function' &&
      typeof (value as { on?: unknown }).on === 'function'
    );
  }

  function isFastifyish(value: unknown): value is FastifyRequest {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { url?: unknown }).url === 'string' &&
      'headers' in value
    );
  }

  /** Recover the code from the URL when params aren't populated on the upgrade. */
  function codeFromUrl(url: string): string | null {
    try {
      const path = new URL(url, 'http://localhost').pathname;
      const match = path.match(/^\/v1\/jams\/([^/]+)\/room$/);
      return match?.[1] ? parseCode(match[1]) : null;
    } catch {
      return null;
    }
  }
}
