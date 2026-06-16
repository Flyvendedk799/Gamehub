import type {
  CreateProjectResponse,
  Engine,
  GenerateGameResponse,
  GetProjectResponse,
  ListProjectsResponse,
  SseEvent,
} from './types';

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3191';
const DEV_USER = '00000000-0000-0000-0000-000000000001';

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-user-id': DEV_USER,
  };
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
  url.searchParams.set('userId', DEV_USER);

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
