import { getToken } from './auth';
import { API_BASE } from './config';
import { RAW_AGENT_TYPES, isRawAgentType, normalizeAgentFrame } from './event-normalize';
import type {
  ChatHistoryResponse,
  CreateProjectResponse,
  Engine,
  GenerateGameResponse,
  GetProjectResponse,
  ListProjectsResponse,
  SseEvent,
} from './types';

const BASE = API_BASE;

function headers(): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/**
 * Typed API error so callers can branch on HTTP status / server error code
 * (e.g. 402 insufficient_credits, 429 concurrent_run_limit) instead of
 * string-matching a message (#27).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(status: number, message: string, code: string | undefined, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...headers(),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let code: string | undefined;
    let body: unknown = text;
    try {
      const parsed: unknown = JSON.parse(text);
      body = parsed;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { error?: unknown }).error === 'string'
      ) {
        code = (parsed as { error: string }).error;
      }
    } catch {
      // non-JSON body — leave code undefined
    }
    throw new ApiError(res.status, `API ${res.status}: ${text}`, code, body);
  }

  return res.json() as Promise<T>;
}

/** Map a thrown ApiError (or any error) to a short, user-facing message (#27). */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 402 || err.code === 'insufficient_credits') {
      const bal = (err.body as { balance?: number } | null)?.balance;
      return typeof bal === 'number'
        ? `Out of credits — you have ${bal} left and each build costs more.`
        : 'Out of credits — top up to keep building.';
    }
    if (err.status === 429) {
      if (err.code === 'concurrent_run_limit') {
        return 'Too many builds at once — wait for the current one to finish.';
      }
      return 'Slow down — too many requests. Try again in a moment.';
    }
    if (err.status === 401 || err.status === 403) {
      return 'You need to sign in to do that.';
    }
    if (err.status >= 500) {
      return 'Something went wrong on our side. Please try again.';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function createProject(
  name: string,
  engine: Engine = 'phaser',
): Promise<CreateProjectResponse> {
  return apiFetch<CreateProjectResponse>('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name, engine }),
  });
}

export async function listProjects(): Promise<ListProjectsResponse> {
  return apiFetch<ListProjectsResponse>('/v1/projects');
}

export async function getProject(id: string): Promise<GetProjectResponse> {
  return apiFetch<GetProjectResponse>(`/v1/projects/${id}`);
}

// ─── Chat history ────────────────────────────────────────────────────────────

export async function getChatHistory(projectId: string): Promise<ChatHistoryResponse> {
  return apiFetch<ChatHistoryResponse>(`/v1/projects/${projectId}/chat`);
}

// ─── Publish ─────────────────────────────────────────────────────────────────

export interface PublishResponse {
  slug: string;
  publishUrl: string;
}

export async function publishProject(projectId: string): Promise<PublishResponse> {
  return apiFetch<PublishResponse>(`/v1/projects/${projectId}/publish`, { method: 'POST' });
}

// ─── Generation ──────────────────────────────────────────────────────────────

export async function generateGame(
  projectId: string,
  prompt: string,
): Promise<GenerateGameResponse> {
  return apiFetch<GenerateGameResponse>(`/v1/projects/${projectId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

// ─── Hub ─────────────────────────────────────────────────────────────────────

export interface HubGame {
  id: string;
  projectId: string;
  publishSlug: string;
  title: string;
  thumbnailUrl: string | null;
  description: string | null;
  genre: string | null;
  tags: string[];
  remixCount: number;
  status: string;
  playCount: number;
  ratingAvg: number;
  ratingCount: number;
  publishedAt: string;
}

export interface HubComment {
  id: string;
  publishedGameId: string;
  userId: string;
  body: string;
  parentCommentId: string | null;
  createdAt: string;
  /** Author-resolved fields (Phase 3.9). Null when the author can't be resolved. */
  authorHandle: string | null;
  authorDisplayName: string | null;
}

export type HubSort = 'recent' | 'popular' | 'trending';

export interface HubFeedOptions {
  sort?: HubSort;
  /** Genre slug to filter by; empty/undefined = all genres. */
  genre?: string;
  /** Single tag to filter by; empty/undefined = no tag filter. */
  tag?: string;
  limit?: number;
  offset?: number;
}

/**
 * Pure builder for the `/v1/hub` query string (#3.3/#3.4). Extracted so the
 * sort/genre/tag composition is unit-testable without a live fetch. Empty
 * strings are treated as "no filter" so the UI can pass `genre: ''` for "All".
 */
export function buildHubFeedQuery(opts?: HubFeedOptions): string {
  const params = new URLSearchParams();
  if (opts?.sort) params.set('sort', opts.sort);
  if (opts?.genre && opts.genre.trim().length > 0) params.set('genre', opts.genre.trim());
  if (opts?.tag && opts.tag.trim().length > 0) params.set('tag', opts.tag.trim());
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
  return params.toString();
}

export async function getHubFeed(opts?: HubFeedOptions): Promise<{ games: HubGame[] }> {
  const qs = buildHubFeedQuery(opts);
  return apiFetch<{ games: HubGame[] }>(`/v1/hub${qs ? `?${qs}` : ''}`);
}

export async function toggleLike(slug: string): Promise<{ liked: boolean }> {
  return apiFetch<{ liked: boolean }>(`/v1/hub/games/${slug}/like`, { method: 'POST' });
}

export async function setRating(
  slug: string,
  stars: number,
): Promise<{ ratingAvg: number; ratingCount: number }> {
  return apiFetch<{ ratingAvg: number; ratingCount: number }>(`/v1/hub/games/${slug}/rate`, {
    method: 'POST',
    body: JSON.stringify({ stars }),
  });
}

export async function getComments(slug: string): Promise<{ comments: HubComment[] }> {
  return apiFetch<{ comments: HubComment[] }>(`/v1/hub/games/${slug}/comments`);
}

export async function addComment(slug: string, body: string): Promise<HubComment> {
  return apiFetch<HubComment>(`/v1/hub/games/${slug}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function remixGame(slug: string): Promise<{ projectId: string; parentSlug: string }> {
  return apiFetch<{ projectId: string; parentSlug: string }>(`/v1/hub/games/${slug}/remix`, {
    method: 'POST',
  });
}

/**
 * Detail view for a single published game (#3.6). Carries the hub-only
 * `remixCount` + `parentSlug` (attribution) on top of the PublishedGame fields,
 * which now also include description/tags/genre.
 */
export interface HubGameDetail {
  id: string;
  projectId: string;
  publishSlug: string;
  title: string;
  thumbnailUrl: string | null;
  description: string | null;
  genre: string | null;
  tags: string[];
  status: string;
  playCount: number;
  ratingAvg: number;
  ratingCount: number;
  publishedAt: string;
  remixCount: number;
  parentSlug: string | null;
}

export async function getHubGame(slug: string): Promise<{ game: HubGameDetail }> {
  return apiFetch<{ game: HubGameDetail }>(`/v1/hub/games/${slug}`);
}

export async function reportGame(slug: string, reason?: string): Promise<void> {
  await apiFetch<unknown>(`/v1/hub/games/${slug}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// ─── Leaderboards (Phase 3.8) ──────────────────────────────────────────────────

/** One leaderboard row — a score plus the (optional) author's display handle. */
export interface LeaderboardEntry {
  score: number;
  /** Null for an anonymous score. */
  userId: string | null;
  /** Author's @handle, resolved for display. Null when anonymous/unresolved. */
  handle: string | null;
  createdAt: string;
}

/**
 * Submit a leaderboard score for a game (Phase 3.8). No auth required — the
 * server attributes a signed-in submitter so the board can show a @handle, and
 * rate-caps per session. A 429 means "already submitted this window"; callers
 * swallow it (the score the player already posted stands).
 */
export async function submitScore(slug: string, score: number): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/v1/play/${slug}/score`, {
    method: 'POST',
    body: JSON.stringify({ score }),
  });
}

/** Top-10 leaderboard for a game, highest score first (Phase 3.8). */
export async function getLeaderboard(slug: string): Promise<{ entries: LeaderboardEntry[] }> {
  return apiFetch<{ entries: LeaderboardEntry[] }>(`/v1/play/${slug}/leaderboard`);
}

// ─── Creator profiles ────────────────────────────────────────────────────────

export interface CreatorProfile {
  handle: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  projectCount: number;
  /** Follower count (Phase 3.9). */
  followerCount: number;
  /** Whether the current viewer follows this creator (false when signed-out). */
  isFollowing: boolean;
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    engine: string | null;
    visibility: string;
    updatedAt: string;
  }>;
}

export async function getCreatorProfile(handle: string): Promise<CreatorProfile> {
  return apiFetch<CreatorProfile>(`/v1/users/${handle}`);
}

/** Follow a creator (Phase 3.9). Auth required; idempotent server-side. */
export async function followUser(
  handle: string,
): Promise<{ following: boolean; followerCount: number }> {
  return apiFetch<{ following: boolean; followerCount: number }>(`/v1/users/${handle}/follow`, {
    method: 'POST',
  });
}

/** Unfollow a creator (Phase 3.9). Auth required; idempotent server-side. */
export async function unfollowUser(
  handle: string,
): Promise<{ following: boolean; followerCount: number }> {
  return apiFetch<{ following: boolean; followerCount: number }>(`/v1/users/${handle}/follow`, {
    method: 'DELETE',
  });
}

/**
 * A creator's PUBLISHED games (#3.1) — carries `thumbnailUrl` + `publishSlug`
 * so the profile renders the same thumbnail gallery as the Hub, with cards that
 * link to the public play page.
 */
export interface CreatorGame {
  id: string;
  projectId: string;
  publishSlug: string;
  title: string;
  thumbnailUrl: string | null;
  description: string | null;
  genre: string | null;
  tags: string[];
  status: string;
  publishedAt: string;
}

export async function getCreatorGames(
  handle: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ handle: string; games: CreatorGame[] }> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return apiFetch<{ handle: string; games: CreatorGame[] }>(
    `/v1/users/${handle}/games${qs ? `?${qs}` : ''}`,
  );
}

// ─── Version timeline ────────────────────────────────────────────────────────

export interface SnapshotEntry {
  id: string;
  seq: number;
  type: 'initial' | 'edit' | 'fork' | 'remix' | 'revert';
  prompt: string | null;
  engine: 'three' | 'phaser' | null;
  tweakSchema: Record<string, unknown> | null;
  createdAt: string;
}

export async function getSnapshots(projectId: string): Promise<{ snapshots: SnapshotEntry[] }> {
  return apiFetch<{ snapshots: SnapshotEntry[] }>(`/v1/projects/${projectId}/snapshots`);
}

export async function revertToSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ ok: boolean; snapshotId: string }> {
  return apiFetch<{ ok: boolean; snapshotId: string }>(
    `/v1/projects/${projectId}/snapshots/${snapshotId}/revert`,
    { method: 'POST' },
  );
}

// ─── SSE streaming ───────────────────────────────────────────────────────────
//
// EventSource cannot set custom headers. We pass userId as a query param
// and the server needs to accept it from query params as well:
//   GET /v1/runs/:id/stream?userId=<uuid>
//
// Server-side change needed: read `userId` from `req.query.userId` in addition
// to `x-user-id` header when authenticating the SSE route.

export interface StreamController {
  close: () => void;
}

/**
 * Already-normalized `SseEvent` types the server may emit directly (and that a
 * reconnect may replay). The agent's RAW wire frames (tool_execution_start /
 * _end, message_update, run_paused) are NOT in this list — they are parsed +
 * normalized separately by `parseSseFrames` (Phase 2.1) so the build feed no
 * longer silently drops the agent's rich events.
 */
export const SSE_NAMED_TYPES: ReadonlyArray<SseEvent['type']> = [
  'agent_start',
  'turn_start',
  'turn_end',
  'agent_end',
  'run_complete',
  'run_error',
  'message_update',
  'text_delta',
  'tool_use',
  'tool_result',
  'thinking_delta',
  'game_spec',
  'run_paused',
];

/**
 * Every SSE event/frame type the EventSource should register a named listener
 * for. The server currently sends frames as default `message` events (no
 * `event:` line), but named listeners are belt-and-suspenders for any frame
 * the server chooses to name (#10). Includes the raw agent frame types so a
 * named `tool_execution_start`/etc. is not missed.
 */
export const SSE_LISTENER_TYPES: ReadonlyArray<string> = [...SSE_NAMED_TYPES, ...RAW_AGENT_TYPES];

/**
 * Pure parser for a single SSE data frame. Returns the typed event or `null`
 * for malformed/empty frames. Extracted so it can be unit-tested without a
 * live EventSource (#16). Only recognizes already-normalized `SseEvent` types;
 * raw agent wire frames go through `parseSseFrames`.
 */
export function parseSseFrame(data: string): SseEvent | null {
  if (typeof data !== 'string' || data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  if (!SSE_NAMED_TYPES.includes(type as SseEvent['type'])) return null;
  return parsed as SseEvent;
}

/**
 * Parse a single SSE data frame into zero-or-more renderable `SseEvent`s
 * (Phase 2.1). A RAW agent frame is normalized (one frame can fan out to
 * multiple events — e.g. a spec tool start yields tool_use + game_spec); an
 * already-normalized frame passes through as a single-element array. Malformed
 * or unrecognized frames yield `[]` instead of vanishing silently.
 *
 * `runId` stamps synthesized events because the bus frames omit it.
 */
export function parseSseFrames(data: string, runId: string): SseEvent[] {
  if (typeof data !== 'string' || data.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') return [];
  if (isRawAgentType(type)) {
    return normalizeAgentFrame(parsed as Record<string, unknown>, { runId });
  }
  const normalized = parseSseFrame(data);
  return normalized ? [normalized] : [];
}

/**
 * True when an event ends the stream and reconnection must stop (#10). Includes
 * `run_paused` (Phase 2.5) — the backend publishes it then closes the stream,
 * so a reconnect must NOT spin trying to resume a paused run; the user resumes
 * explicitly via the Resume button.
 */
export function isTerminalSseEvent(event: SseEvent): boolean {
  return event.type === 'run_complete' || event.type === 'run_error' || event.type === 'run_paused';
}

export interface StreamRunOptions {
  /** Fired when a transient disconnect triggers a reconnect attempt (#10). */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Fired once the stream gives up after exhausting retries. */
  onGiveUp?: () => void;
  /** Max reconnect attempts before giving up. Default 6. */
  maxAttempts?: number;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 16_000;

/** Capped exponential backoff: 0.5s, 1s, 2s, …, capped at ~16s (#10). */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

export function streamRun(
  runId: string,
  onEvent: (event: SseEvent) => void,
  onError?: (err: Event) => void,
  options?: StreamRunOptions,
): StreamController {
  const maxAttempts = options?.maxAttempts ?? 6;

  let es: EventSource | null = null;
  let closed = false;
  let terminal = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const url = new URL(`${BASE}/v1/runs/${runId}/stream`);
  const token = getToken();
  if (token) url.searchParams.set('token', token);

  function handleFrame(data: string) {
    // One wire frame can normalize to several renderable events (Phase 2.1):
    // a spec tool start yields tool_use + game_spec. Deliver each in order.
    const events = parseSseFrames(data, runId);
    if (events.length === 0) return;
    for (const parsed of events) {
      if (isTerminalSseEvent(parsed)) {
        // Terminal: deliver, then stop the stream and all reconnection
        // (#10/#34, Phase 2.5 run_paused).
        terminal = true;
        onEvent(parsed);
        teardown();
        return;
      }
      // Reset the backoff counter on any successful frame — the connection is
      // healthy, so a later blip should retry from scratch.
      attempt = 0;
      onEvent(parsed);
    }
  }

  function teardown() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    es?.close();
    es = null;
  }

  function connect() {
    if (closed || terminal) return;
    es = new EventSource(url.toString());

    es.onmessage = (msgEvent: MessageEvent<string>) => handleFrame(msgEvent.data);

    for (const eventType of SSE_LISTENER_TYPES) {
      es.addEventListener(eventType, (evt: Event) => {
        handleFrame((evt as MessageEvent<string>).data);
      });
    }

    es.onerror = (err: Event) => {
      onError?.(err);
      if (closed || terminal) return;
      // EventSource auto-reconnects on its own, but we layer a capped backoff
      // and a give-up bound so a permanently-dead run doesn't spin forever.
      // The server bus replays history on reconnect, so resume is clean (#10).
      es?.close();
      es = null;
      if (attempt >= maxAttempts) {
        options?.onGiveUp?.();
        return;
      }
      const delay = reconnectDelay(attempt);
      attempt += 1;
      options?.onReconnecting?.(attempt, delay);
      reconnectTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    close: () => {
      closed = true;
      teardown();
    },
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  handle: string;
  displayName: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export async function register(
  email: string,
  password: string,
  handle: string,
  displayName?: string,
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, handle, displayName }),
  });
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<unknown>('/v1/auth/logout', { method: 'POST' });
}

export interface MeResponse {
  userId: string;
  handle: string;
  onboardingComplete?: boolean;
  defaultProvider?: AccountProvider;
  /** Credit balance; omitted for BYOK/unmetered users (Infinity server-side). */
  balance?: number;
}

export async function getMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/v1/auth/me');
}

// ─── Account settings ───────────────────────────────────────────────────────

export type AccountProvider = 'platform' | 'anthropic' | 'openai';

export interface AccountProviderState {
  provider: AccountProvider;
  label: string;
  configured: boolean;
  last4: string | null;
  defaultModelId: string;
  active: boolean;
  keyHelpUrl?: string;
}

export interface AccountSettingsResponse {
  user: {
    id: string;
    email: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
  };
  defaultProvider: AccountProvider;
  defaultModelId: string;
  onboardingComplete: boolean;
  providers: AccountProviderState[];
}

export async function getAccountSettings(): Promise<AccountSettingsResponse> {
  return apiFetch<AccountSettingsResponse>('/v1/account/settings');
}

export async function updateAccountProfile(input: {
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
}): Promise<AccountSettingsResponse> {
  return apiFetch<AccountSettingsResponse>('/v1/account/profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function saveAccountProvider(input: {
  provider: AccountProvider;
  modelId?: string;
  apiKey?: string;
  completeOnboarding?: boolean;
}): Promise<AccountSettingsResponse> {
  return apiFetch<AccountSettingsResponse>('/v1/account/provider', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteAccountProvider(provider: Exclude<AccountProvider, 'platform'>) {
  return apiFetch<AccountSettingsResponse>(`/v1/account/provider/${provider}`, {
    method: 'DELETE',
  });
}

// ─── Hub search ────────────────────────────────────────────────────────────────

export async function searchHub(
  q: string,
  opts?: { limit?: number },
): Promise<{ results: HubGame[] }> {
  const params = new URLSearchParams({ q });
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  return apiFetch<{ results: HubGame[] }>(`/v1/hub/search?${params.toString()}`);
}
