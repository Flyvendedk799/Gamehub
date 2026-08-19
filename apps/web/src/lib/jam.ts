/**
 * Game Jam client — the party mode's API surface plus the seat-token store.
 *
 * A jam has TWO identities and they are not interchangeable:
 *
 *  - the **session token** (`pf_token`, in `auth.ts`) says who you are on the
 *    platform. Only the host needs one, because the host's account owns the
 *    game the jam builds and their credits pay for it.
 *  - the **seat token** (here) says who you are IN A ROOM. It is minted at join,
 *    stored per room code, and is the ONLY thing a guest needs — which is the
 *    point: handing a friend a four-character code beats making them sign up
 *    while everyone waits.
 *
 * Seat tokens are per-code so one device can hold seats in several rooms (a host
 * testing on their laptop while playing on their phone) without them colliding.
 */
import type { CompiledJamBrief, JamConfig, JamEngine, JamState } from '@playforge/shared/game-jam';
import { getToken } from './auth';
import { API_BASE, API_WS_BASE } from './config';

export type { JamState, JamConfig, CompiledJamBrief };

/** What the server hands back once — the seat's id and its bearer token. */
export interface JamSeat {
  playerId: string;
  token: string;
}

export interface JamRoomSummary {
  id: string;
  code: string;
  phase: JamState['phase'];
  playerCount: number;
  title: string | null;
  projectId: string | null;
  playSlug: string | null;
  createdAt: string;
}

// ── seat storage ─────────────────────────────────────────────────────────────

const SEAT_PREFIX = 'pf_jam_seat:';

function seatKey(code: string): string {
  return `${SEAT_PREFIX}${code.toUpperCase()}`;
}

/** Remember this device's seat in a room so a refresh doesn't eject the player. */
export function saveJamSeat(code: string, seat: JamSeat): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(seatKey(code), JSON.stringify(seat));
  } catch {
    // Private-mode / quota. The seat still works for this page's lifetime; the
    // player just re-joins after a refresh rather than losing the whole room.
  }
}

export function getJamSeat(code: string): JamSeat | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(seatKey(code));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<JamSeat>;
    if (typeof parsed.playerId !== 'string' || typeof parsed.token !== 'string') return null;
    return { playerId: parsed.playerId, token: parsed.token };
  } catch {
    return null;
  }
}

export function clearJamSeat(code: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(seatKey(code));
  } catch {
    /* nothing to clear */
  }
}

/** Remember the display name so the next jam pre-fills it. */
const NAME_KEY = 'pf_jam_name';

export function getRememberedJamName(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberJamName(name: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* best effort */
  }
}

// ── transport ────────────────────────────────────────────────────────────────

/** A failed jam call, carrying the server's error code for branching. */
export class JamError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'JamError';
    this.status = status;
    this.code = code;
  }
}

/** Short, human sentences for the error codes the room UI can actually hit. */
const JAM_ERROR_COPY: Record<string, string> = {
  jam_not_found: "That room code doesn't exist. Check the letters and try again.",
  jam_full: 'That room is full — 8 players is the max.',
  jam_closed: 'That jam has already started building. Ask the host to start a new one.',
  jam_seat_required: 'Join the room first.',
  jam_seat_invalid: 'Your seat expired. Re-join with the room code.',
  jam_host_only: 'Only the host can do that.',
  jam_needs_players: 'You need at least 2 players to start.',
  jam_already_started: 'The jam already started.',
  jam_not_accepting_answers: 'That round is over — hang tight for the next one.',
  jam_not_in_reveal: 'Not in the reveal right now.',
  jam_no_self_vote: "You can't hype your own idea.",
  jam_rounds_complete: 'That was the last question — time to build it.',
  jam_not_ready: 'Get at least 2 players and one idea on the board first.',
  jam_already_building: "It's already building.",
  jam_not_built: 'Build the game first.',
  jam_game_not_published: 'Publish the game first so everyone can play it.',
  insufficient_credits: 'The host is out of credits — top up to build this jam.',
  concurrent_run_limit: 'The host already has a build running. Wait for it to finish.',
  name_required: 'Pick a name so the room knows who you are.',
  answer_required: 'Type an idea first.',
};

/** Map a thrown error to one sentence a player can act on. */
export function describeJamError(err: unknown): string {
  if (err instanceof JamError) {
    if (err.code && JAM_ERROR_COPY[err.code]) return JAM_ERROR_COPY[err.code] as string;
    if (err.status >= 500) return 'Something broke on our side. Try again.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

async function jamFetch<T>(
  path: string,
  init?: RequestInit & { seatToken?: string | null },
): Promise<T> {
  const headers: Record<string, string> = {};
  const session = getToken();
  if (session) headers['Authorization'] = `Bearer ${session}`;
  if (init?.seatToken) headers['X-Jam-Token'] = init.seatToken;
  const hasBody = init?.body !== undefined && init?.body !== null;
  if (hasBody) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') code = parsed.error;
    } catch {
      /* non-JSON error body */
    }
    throw new JamError(res.status, code, code ?? `Jam request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// ── calls ────────────────────────────────────────────────────────────────────

export interface CreateJamInput {
  name: string;
  rounds?: number;
  engine?: JamEngine;
  answerSeconds?: number;
}

export async function createJam(
  input: CreateJamInput,
): Promise<{ state: JamState; seat: JamSeat }> {
  return jamFetch('/v1/jams', { method: 'POST', body: JSON.stringify(input) });
}

export async function joinJam(
  code: string,
  name: string,
): Promise<{ state: JamState; seat: JamSeat }> {
  return jamFetch(`/v1/jams/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function getJam(
  code: string,
  seatToken?: string | null,
): Promise<{ state: JamState; you: string | null }> {
  return jamFetch(`/v1/jams/${encodeURIComponent(code)}`, { seatToken: seatToken ?? null });
}

export async function listMyJams(): Promise<{ jams: JamRoomSummary[] }> {
  return jamFetch('/v1/jams');
}

/** POST a bodyless room action with the caller's seat token. */
function jamAction<T>(code: string, action: string, seatToken: string, body?: unknown): Promise<T> {
  return jamFetch<T>(`/v1/jams/${encodeURIComponent(code)}/${action}`, {
    method: 'POST',
    seatToken,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function startJam(code: string, seatToken: string): Promise<{ ok: true }> {
  return jamAction(code, 'start', seatToken);
}

export function submitJamAnswer(
  code: string,
  seatToken: string,
  text: string,
): Promise<{ ok: true; revealed: boolean }> {
  return jamAction(code, 'answer', seatToken, { text });
}

export function revealJamRound(code: string, seatToken: string): Promise<{ ok: true }> {
  return jamAction(code, 'reveal', seatToken);
}

export function voteJamAnswer(
  code: string,
  seatToken: string,
  answerId: string,
): Promise<{ ok: true; voted: boolean }> {
  return jamAction(code, 'vote', seatToken, { answerId });
}

export function nextJamRound(code: string, seatToken: string): Promise<{ ok: true }> {
  return jamAction(code, 'next', seatToken);
}

export function buildJam(
  code: string,
  seatToken: string,
): Promise<{ projectId: string; runId: string }> {
  return jamAction(code, 'build', seatToken);
}

export function publishJam(code: string, seatToken: string): Promise<{ playSlug: string }> {
  return jamAction(code, 'publish', seatToken);
}

export function leaveJam(code: string, seatToken: string): Promise<{ ok: true }> {
  return jamAction(code, 'leave', seatToken);
}

export function endJam(code: string, seatToken: string): Promise<{ ok: true }> {
  return jamAction(code, 'end', seatToken);
}

export async function getJamBrief(
  code: string,
  seatToken: string,
): Promise<{ brief: CompiledJamBrief; canBuild: boolean }> {
  return jamFetch(`/v1/jams/${encodeURIComponent(code)}/brief`, { seatToken });
}

/** WebSocket URL for a room, carrying the seat token (headers aren't available). */
export function jamRoomSocketUrl(code: string, seatToken: string | null): string {
  const url = new URL(`${API_WS_BASE}/v1/jams/${encodeURIComponent(code)}/room`);
  if (seatToken) url.searchParams.set('jamToken', seatToken);
  return url.toString();
}

/** Absolute, shareable invite link for a room. */
export function jamInviteUrl(code: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return `${base}/jam/${code.toUpperCase()}`;
}
