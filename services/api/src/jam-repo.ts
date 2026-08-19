/**
 * Game Jam repository — the party room's storage port.
 *
 * Routes depend on this interface, not on Drizzle, so the whole jam surface is
 * testable through `fastify.inject()` with no Postgres. `DrizzleJamRepo` (in
 * drizzle-repos.ts) is the production impl.
 *
 * ## Seat tokens
 * A jam seat is authenticated by an opaque token minted at join and handed to
 * that device once. Only its SHA-256 hash is persisted, so a database read
 * cannot impersonate a player — the same posture as password-reset tokens. A
 * seat token grants exactly one capability: acting as that player in that room.
 *
 * ## Where `connected` comes from
 * It does NOT come from here. Liveness is per-API-instance socket state, and
 * writing it to Postgres on every phone screen-lock would be write
 * amplification for a fact that is stale the moment it lands. The repo always
 * reports `connected: false`; server.ts overlays the live socket set before
 * broadcasting.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  JAM_MAX_PLAYERS,
  JAM_SCHEMA_VERSION,
  type JamAnswer,
  type JamConfig,
  type JamPhase,
  type JamPlayer,
  type JamState,
  generateJamCode,
  jamColorForSeat,
  jamRoundPlan,
  jamTitleFromState,
} from '@playforge/shared';

/** Hash a raw seat token for storage/lookup. */
export function hashJamToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint a raw seat token. Returned to the client exactly once. */
export function mintJamToken(): string {
  return randomBytes(24).toString('base64url');
}

/** A seat handed back to a device: its player id plus the raw token. */
export interface JamSeat {
  playerId: string;
  token: string;
}

export interface CreateJamInput {
  hostUserId: string;
  hostName: string;
  config: JamConfig;
}

export interface JoinJamInput {
  name: string;
  /** Set when the joiner happens to be signed in; null for a guest. */
  userId: string | null;
}

/** Why a join was refused — mapped to an HTTP status by the route. */
export type JamJoinFailure = 'full' | 'closed';

export interface JamSummary {
  id: string;
  code: string;
  phase: JamPhase;
  playerCount: number;
  title: string | null;
  projectId: string | null;
  playSlug: string | null;
  createdAt: string;
}

/** Fields a phase transition may set alongside the phase itself. */
export interface JamPhasePatch {
  round?: number;
  /** Epoch ms; explicit null clears a timer. */
  deadlineAt?: number | null;
}

export interface JamRepo {
  create(input: CreateJamInput): Promise<{ state: JamState; seat: JamSeat }>;
  /** Live (not ended) room id for a code. Ended rooms are invisible to joiners. */
  findLiveIdByCode(code: string): Promise<string | null>;
  getState(jamId: string): Promise<JamState | null>;
  join(jamId: string, input: JoinJamInput): Promise<{ seat: JamSeat } | { error: JamJoinFailure }>;
  /** Authenticate a seat token against a room. Null when it does not belong. */
  resolveSeat(jamId: string, token: string): Promise<JamPlayer | null>;
  /** Mark a player as having left. The row stays so their ideas keep attribution. */
  leave(jamId: string, playerId: string): Promise<void>;
  setPhase(jamId: string, phase: JamPhase, patch?: JamPhasePatch): Promise<void>;
  /** Upsert this player's answer for a round (re-submitting EDITS). */
  submitAnswer(input: {
    jamId: string;
    playerId: string;
    round: number;
    promptId: string;
    text: string;
  }): Promise<void>;
  /** Toggle a hype vote. Resolves to the vote's new state (true = voted). */
  toggleVote(jamId: string, answerId: string, voterPlayerId: string): Promise<boolean>;
  attachBuild(jamId: string, projectId: string, runId: string): Promise<void>;
  setPlaySlug(jamId: string, playSlug: string): Promise<void>;
  end(jamId: string): Promise<void>;
  /** Rooms this user hosted, newest first. */
  listByHost(hostUserId: string): Promise<JamSummary[]>;
}

// ── shared assembly helpers ──────────────────────────────────────────────────

/**
 * Assemble the broadcastable room snapshot from its parts. Shared by both repo
 * impls so the in-memory tests exercise the SAME state shape production emits —
 * including the derived fields (`answeredPlayerIds`, `title`) that the UI keys
 * off. Players who left are dropped from the roster but their answers survive:
 * a jam is a record of what the room made, not of who is still holding a phone.
 */
export function assembleJamState(parts: {
  id: string;
  code: string;
  hostPlayerId: string;
  phase: JamPhase;
  config: JamConfig;
  round: number;
  roundPromptIds: string[];
  players: JamPlayer[];
  answers: JamAnswer[];
  deadlineAt: number | null;
  projectId: string | null;
  runId: string | null;
  playSlug: string | null;
  createdAt: string;
  updatedAt: string;
}): JamState {
  const state: JamState = {
    schemaVersion: JAM_SCHEMA_VERSION,
    id: parts.id,
    code: parts.code,
    hostPlayerId: parts.hostPlayerId,
    phase: parts.phase,
    config: parts.config,
    round: parts.round,
    roundPromptIds: parts.roundPromptIds,
    players: [...parts.players].sort((a, b) => a.seat - b.seat),
    answers: [...parts.answers].sort(
      (a, b) => a.round - b.round || (a.createdAt < b.createdAt ? -1 : 1),
    ),
    answeredPlayerIds: parts.answers
      .filter((a) => a.round === parts.round && a.text.trim() !== '')
      .map((a) => a.playerId),
    deadlineAt: parts.deadlineAt,
    projectId: parts.projectId,
    runId: parts.runId,
    playSlug: parts.playSlug,
    title: null,
    createdAt: parts.createdAt,
    updatedAt: parts.updatedAt,
  };
  return { ...state, title: jamTitleFromState(state) };
}

// ── in-memory impl ───────────────────────────────────────────────────────────

interface MemJam {
  id: string;
  code: string;
  hostUserId: string;
  hostPlayerId: string;
  phase: JamPhase;
  config: JamConfig;
  roundPromptIds: string[];
  round: number;
  deadlineAt: number | null;
  projectId: string | null;
  runId: string | null;
  playSlug: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  players: Array<JamPlayer & { tokenHash: string; leftAt: string | null }>;
  answers: JamAnswer[];
  /** answerId → set of voter player ids. */
  votes: Map<string, Set<string>>;
}

/**
 * In-memory JamRepo for tests and for local dev without Postgres. Ids are
 * sequential (`jam_00000001`) so assertions can name them; tokens are still
 * real random values so token handling is exercised honestly.
 */
export class InMemoryJamRepo implements JamRepo {
  private readonly byId = new Map<string, MemJam>();
  private seq = 0;

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly rand: () => number = Math.random,
  ) {}

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString().padStart(8, '0')}`;
  }

  /** A code not currently held by a live room. Falls back to a unique suffix. */
  private freshCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = generateJamCode(this.rand);
      const taken = [...this.byId.values()].some((j) => j.endedAt === null && j.code === code);
      if (!taken) return code;
    }
    return generateJamCode(this.rand);
  }

  async create(input: CreateJamInput): Promise<{ state: JamState; seat: JamSeat }> {
    const ts = this.now();
    const id = this.nextId('jam');
    const playerId = this.nextId('jp');
    const token = mintJamToken();
    const color = jamColorForSeat(0);
    const jam: MemJam = {
      id,
      code: this.freshCode(),
      hostUserId: input.hostUserId,
      hostPlayerId: playerId,
      phase: 'lobby',
      config: input.config,
      roundPromptIds: jamRoundPlan(input.config.rounds).map((c) => c.id),
      round: 0,
      deadlineAt: null,
      projectId: null,
      runId: null,
      playSlug: null,
      createdAt: ts,
      updatedAt: ts,
      endedAt: null,
      players: [
        {
          id: playerId,
          userId: input.hostUserId,
          name: input.hostName,
          color: color.id,
          seat: 0,
          isHost: true,
          connected: false,
          joinedAt: ts,
          tokenHash: hashJamToken(token),
          leftAt: null,
        },
      ],
      answers: [],
      votes: new Map(),
    };
    this.byId.set(id, jam);
    const state = await this.getState(id);
    // Non-null: we just inserted it.
    return { state: state as JamState, seat: { playerId, token } };
  }

  async findLiveIdByCode(code: string): Promise<string | null> {
    for (const jam of this.byId.values()) {
      if (jam.endedAt === null && jam.code === code) return jam.id;
    }
    return null;
  }

  async getState(jamId: string): Promise<JamState | null> {
    const jam = this.byId.get(jamId);
    if (!jam) return null;
    return assembleJamState({
      id: jam.id,
      code: jam.code,
      hostPlayerId: jam.hostPlayerId,
      phase: jam.phase,
      config: jam.config,
      round: jam.round,
      roundPromptIds: jam.roundPromptIds,
      players: jam.players
        .filter((p) => p.leftAt === null)
        .map(({ tokenHash: _t, leftAt: _l, ...p }) => ({ ...p, connected: false })),
      answers: jam.answers.map((a) => ({ ...a, votes: jam.votes.get(a.id)?.size ?? 0 })),
      deadlineAt: jam.deadlineAt,
      projectId: jam.projectId,
      runId: jam.runId,
      playSlug: jam.playSlug,
      createdAt: jam.createdAt,
      updatedAt: jam.updatedAt,
    });
  }

  async join(
    jamId: string,
    input: JoinJamInput,
  ): Promise<{ seat: JamSeat } | { error: JamJoinFailure }> {
    const jam = this.byId.get(jamId);
    if (!jam || jam.endedAt !== null) return { error: 'closed' };
    // Late joins are welcome while the room is still writing ideas — a friend
    // walking in on round 3 should get a seat, not a door. Once the build has
    // started the roster is baked into the brief, so the room is closed.
    if (jam.phase === 'building' || jam.phase === 'ready' || jam.phase === 'ended') {
      return { error: 'closed' };
    }
    const active = jam.players.filter((p) => p.leftAt === null);
    if (active.length >= JAM_MAX_PLAYERS) return { error: 'full' };

    const ts = this.now();
    const playerId = this.nextId('jp');
    const token = mintJamToken();
    // Seat numbers never recycle within a room, so a rejoining player can't
    // steal a departed player's color mid-jam.
    const seat = jam.players.reduce((max, p) => Math.max(max, p.seat + 1), 0);
    jam.players.push({
      id: playerId,
      userId: input.userId,
      name: input.name,
      color: jamColorForSeat(seat).id,
      seat,
      isHost: false,
      connected: false,
      joinedAt: ts,
      tokenHash: hashJamToken(token),
      leftAt: null,
    });
    jam.updatedAt = ts;
    return { seat: { playerId, token } };
  }

  async resolveSeat(jamId: string, token: string): Promise<JamPlayer | null> {
    const jam = this.byId.get(jamId);
    if (!jam) return null;
    const hash = hashJamToken(token);
    const row = jam.players.find((p) => p.tokenHash === hash && p.leftAt === null);
    if (!row) return null;
    const { tokenHash: _t, leftAt: _l, ...player } = row;
    return { ...player, connected: false };
  }

  async leave(jamId: string, playerId: string): Promise<void> {
    const jam = this.byId.get(jamId);
    if (!jam) return;
    const row = jam.players.find((p) => p.id === playerId);
    if (!row || row.leftAt !== null) return;
    row.leftAt = this.now();
    jam.updatedAt = row.leftAt;
  }

  async setPhase(jamId: string, phase: JamPhase, patch?: JamPhasePatch): Promise<void> {
    const jam = this.byId.get(jamId);
    if (!jam) return;
    jam.phase = phase;
    if (patch?.round !== undefined) jam.round = patch.round;
    if (patch?.deadlineAt !== undefined) jam.deadlineAt = patch.deadlineAt;
    if (phase === 'ended') jam.endedAt = this.now();
    jam.updatedAt = this.now();
  }

  async submitAnswer(input: {
    jamId: string;
    playerId: string;
    round: number;
    promptId: string;
    text: string;
  }): Promise<void> {
    const jam = this.byId.get(input.jamId);
    if (!jam) return;
    const ts = this.now();
    const existing = jam.answers.find(
      (a) => a.playerId === input.playerId && a.round === input.round,
    );
    if (existing) {
      existing.text = input.text;
      existing.promptId = input.promptId;
    } else {
      jam.answers.push({
        id: this.nextId('ja'),
        round: input.round,
        promptId: input.promptId,
        playerId: input.playerId,
        text: input.text,
        votes: 0,
        createdAt: ts,
      });
    }
    jam.updatedAt = ts;
  }

  async toggleVote(jamId: string, answerId: string, voterPlayerId: string): Promise<boolean> {
    const jam = this.byId.get(jamId);
    if (!jam) return false;
    let voters = jam.votes.get(answerId);
    if (!voters) {
      voters = new Set();
      jam.votes.set(answerId, voters);
    }
    const voted = voters.has(voterPlayerId);
    if (voted) voters.delete(voterPlayerId);
    else voters.add(voterPlayerId);
    jam.updatedAt = this.now();
    return !voted;
  }

  async attachBuild(jamId: string, projectId: string, runId: string): Promise<void> {
    const jam = this.byId.get(jamId);
    if (!jam) return;
    jam.projectId = projectId;
    jam.runId = runId;
    jam.updatedAt = this.now();
  }

  async setPlaySlug(jamId: string, playSlug: string): Promise<void> {
    const jam = this.byId.get(jamId);
    if (!jam) return;
    jam.playSlug = playSlug;
    jam.updatedAt = this.now();
  }

  async end(jamId: string): Promise<void> {
    await this.setPhase(jamId, 'ended');
  }

  async listByHost(hostUserId: string): Promise<JamSummary[]> {
    const out: JamSummary[] = [];
    for (const jam of this.byId.values()) {
      if (jam.hostUserId !== hostUserId) continue;
      const state = await this.getState(jam.id);
      if (!state) continue;
      out.push({
        id: jam.id,
        code: jam.code,
        phase: jam.phase,
        playerCount: state.players.length,
        title: state.title,
        projectId: jam.projectId,
        playSlug: jam.playSlug,
        createdAt: jam.createdAt,
      });
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}
