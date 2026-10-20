import { API_BASE } from '../config';
import type {
  PartyRoom,
  PartyRoomSummary,
  PlaylistMode,
  RoomState,
  SelectionStrategy,
} from './party-types';

export interface CreatePartyRoomParams {
  title?: string;
  isPrivate?: boolean;
  maxPlayers?: number;
  playlistMode?: PlaylistMode;
  selectionStrategy?: SelectionStrategy;
  hostName?: string;
  avatarId?: string;
  avatarColor?: string;
}

export interface CreatePartyRoomResult {
  roomCode: string;
  roomId: string;
  hostSessionToken: string;
  memberId: string;
  room: PartyRoom;
}

export interface PartyRoomStatusResult {
  roomId: string;
  roomCode: string;
  title: string;
  state: RoomState;
  memberCount: number;
  maxPlayers: number;
  isPrivate: boolean;
  allowSpectators: boolean;
}

export interface JoinPartyRoomParams {
  displayName: string;
  avatarId?: string;
  avatarColor?: string;
  rolePreference?: 'PLAYER' | 'SPECTATOR';
}

export interface JoinPartyRoomResult {
  memberId: string;
  sessionToken: string;
  wsEndpoint: string;
  room: PartyRoom;
}

export interface PartyDirectoryResult {
  totalRooms: number;
  rooms: PartyRoomSummary[];
}

export interface ReconnectPartyResult {
  success: boolean;
  roomSnapshot: PartyRoom;
  restoredState: unknown;
}

export class PartyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PartyApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const hasBody = init?.body !== undefined && init?.body !== null;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let errorCode: string | undefined;
    let errorMessage = `HTTP ${res.status}`;
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object') {
        errorCode = (parsed as { code?: string }).code;
        errorMessage = (parsed as { error?: string }).error || errorMessage;
      }
    } catch {
      // response wasn't JSON
    }
    throw new PartyApiError(res.status, errorMessage, errorCode);
  }

  return res.json() as Promise<T>;
}

export async function createPartyRoom(
  params: CreatePartyRoomParams,
): Promise<CreatePartyRoomResult> {
  return request<CreatePartyRoomResult>('/api/v1/party/rooms', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function getPartyRoomStatus(roomCode: string): Promise<PartyRoomStatusResult> {
  return request<PartyRoomStatusResult>(`/api/v1/party/rooms/${encodeURIComponent(roomCode)}`);
}

export async function joinPartyRoom(
  roomCode: string,
  params: JoinPartyRoomParams,
): Promise<JoinPartyRoomResult> {
  return request<JoinPartyRoomResult>(`/api/v1/party/rooms/${encodeURIComponent(roomCode)}/join`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function listPartyDirectory(page = 1, limit = 20): Promise<PartyDirectoryResult> {
  return request<PartyDirectoryResult>(`/api/v1/party/directory?page=${page}&limit=${limit}`);
}

export async function reconnectPartyRoom(
  roomCode: string,
  sessionToken: string,
  memberId: string,
): Promise<ReconnectPartyResult> {
  return request<ReconnectPartyResult>(
    `/api/v1/party/rooms/${encodeURIComponent(roomCode)}/reconnect`,
    {
      method: 'POST',
      body: JSON.stringify({ sessionToken, memberId }),
    },
  );
}
