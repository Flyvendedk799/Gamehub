import type {
  ChatHistoryResponse,
  CreateProjectResponse,
  Engine,
  GenerateGameResponse,
  GetProjectResponse,
  ListProjectsResponse,
  SseEvent,
} from './types';
import { getToken } from './auth';

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3191';

function headers(): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
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
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
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
}

export async function getHubFeed(opts?: { sort?: 'recent' | 'popular'; limit?: number; offset?: number }): Promise<{ games: HubGame[] }> {
  const params = new URLSearchParams();
  if (opts?.sort) params.set('sort', opts.sort);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return apiFetch<{ games: HubGame[] }>(`/v1/hub${qs ? `?${qs}` : ''}`);
}

export async function toggleLike(slug: string): Promise<{ liked: boolean }> {
  return apiFetch<{ liked: boolean }>(`/v1/hub/games/${slug}/like`, { method: 'POST' });
}

export async function setRating(slug: string, stars: number): Promise<{ ratingAvg: number; ratingCount: number }> {
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

export async function remixGame(slug: string): Promise<{ projectId: string }> {
  return apiFetch<{ projectId: string }>(`/v1/hub/games/${slug}/remix`, { method: 'POST' });
}

export async function reportGame(slug: string, reason?: string): Promise<void> {
  await apiFetch<unknown>(`/v1/hub/games/${slug}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// ─── Creator profiles ────────────────────────────────────────────────────────

export interface CreatorProfile {
  handle: string;
  projectCount: number;
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

export async function revertToSnapshot(projectId: string, snapshotId: string): Promise<{ ok: boolean; snapshotId: string }> {
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

export function streamRun(
  runId: string,
  onEvent: (event: SseEvent) => void,
  onError?: (err: Event) => void,
): StreamController {
  const url = new URL(`${BASE}/v1/runs/${runId}/stream`);
  const token = getToken();
  if (token) url.searchParams.set('token', token);

  const es = new EventSource(url.toString());

  es.onmessage = (msgEvent: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(msgEvent.data) as SseEvent;
      onEvent(parsed);
    } catch {
      // ignore malformed frames
    }
  };

  // Listen to named event types the server may emit
  const namedTypes: SseEvent['type'][] = [
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
  ];

  for (const eventType of namedTypes) {
    es.addEventListener(eventType, (evt: Event) => {
      const msgEvt = evt as MessageEvent<string>;
      try {
        const parsed = JSON.parse(msgEvt.data) as SseEvent;
        onEvent(parsed);
      } catch {
        // ignore
      }
    });
  }

  if (onError) {
    es.onerror = onError;
  }

  return {
    close: () => es.close(),
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

export async function getMe(): Promise<{ userId: string; handle: string }> {
  return apiFetch<{ userId: string; handle: string }>('/v1/auth/me');
}
