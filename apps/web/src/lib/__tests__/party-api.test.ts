import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PartyApiError,
  createPartyRoom,
  getPartyRoomStatus,
  joinPartyRoom,
  listPartyDirectory,
  reconnectPartyRoom,
} from '../party/party-api';
import type { PartyRoom } from '../party/party-types';

const mockRoom: PartyRoom = {
  roomId: '11111111-1111-1111-1111-111111111111',
  roomCode: 'PARTY9',
  title: 'Friday Party',
  isPrivate: false,
  maxActivePlayers: 8,
  allowSpectators: true,
  soundBitesEnabled: true,
  state: 'LOBBY',
  hostId: 'host-1',
  members: {
    'host-1': {
      id: 'host-1',
      displayName: 'CaptainGrace',
      avatarId: 'pixel_fox',
      avatarColor: '#6366F1',
      role: 'HOST',
      status: 'READY',
      isHost: true,
      score: 0,
      currentRoundScore: 0,
      hasVetoAvailable: true,
      pingMs: 25,
      joinedAt: Date.now(),
    },
  },
  playlist: {
    mode: 'POINTS_GAUNTLET',
    totalRounds: 5,
    currentRoundIndex: 0,
    selectionStrategy: 'DEMOCRATIC_VOTE',
    intermissionDurationSec: 10,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function stubFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  vi.stubGlobal('fetch', handler);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Party API Client', () => {
  it('creates party room with proper request body and headers', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody: unknown = null;

    stubFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? 'GET';
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          roomCode: 'PARTY9',
          roomId: '11111111-1111-1111-1111-111111111111',
          hostSessionToken: 'sess-host-token',
          memberId: 'host-1',
          room: mockRoom,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await createPartyRoom({
      title: 'Friday Party',
      isPrivate: false,
      maxPlayers: 8,
      playlistMode: 'POINTS_GAUNTLET',
      selectionStrategy: 'DEMOCRATIC_VOTE',
      hostName: 'CaptainGrace',
      avatarId: 'pixel_fox',
      avatarColor: '#6366F1',
    });

    expect(capturedUrl).toContain('/api/v1/party/rooms');
    expect(capturedMethod).toBe('POST');
    expect(capturedBody).toEqual({
      title: 'Friday Party',
      isPrivate: false,
      maxPlayers: 8,
      playlistMode: 'POINTS_GAUNTLET',
      selectionStrategy: 'DEMOCRATIC_VOTE',
      hostName: 'CaptainGrace',
      avatarId: 'pixel_fox',
      avatarColor: '#6366F1',
    });
    expect(res.roomCode).toBe('PARTY9');
    expect(res.hostSessionToken).toBe('sess-host-token');
    expect(res.room.roomId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('fetches room status with encoded room code', async () => {
    let capturedUrl = '';
    stubFetch(async (url) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          roomId: '11111111-1111-1111-1111-111111111111',
          roomCode: 'PARTY9',
          title: 'Friday Party',
          state: 'LOBBY',
          memberCount: 1,
          maxPlayers: 8,
          isPrivate: false,
          allowSpectators: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await getPartyRoomStatus('PARTY9');
    expect(capturedUrl).toContain('/api/v1/party/rooms/PARTY9');
    expect(res.state).toBe('LOBBY');
    expect(res.memberCount).toBe(1);
  });

  it('joins room with member params', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;

    stubFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          memberId: 'member-2',
          sessionToken: 'sess-player-token',
          wsEndpoint: '/ws/party?room=PARTY9',
          room: mockRoom,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await joinPartyRoom('PARTY9', {
      displayName: 'AlexG',
      avatarId: 'neon_cat',
      avatarColor: '#10B981',
      rolePreference: 'PLAYER',
    });

    expect(capturedUrl).toContain('/api/v1/party/rooms/PARTY9/join');
    expect(capturedBody).toEqual({
      displayName: 'AlexG',
      avatarId: 'neon_cat',
      avatarColor: '#10B981',
      rolePreference: 'PLAYER',
    });
    expect(res.memberId).toBe('member-2');
    expect(res.sessionToken).toBe('sess-player-token');
  });

  it('lists directory with pagination query params', async () => {
    let capturedUrl = '';
    stubFetch(async (url) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          totalRooms: 1,
          rooms: [
            {
              roomId: '11111111-1111-1111-1111-111111111111',
              roomCode: 'PARTY9',
              title: 'Friday Party',
              state: 'LOBBY',
              memberCount: 1,
              maxPlayers: 8,
              isPrivate: false,
              allowSpectators: true,
              playlistMode: 'POINTS_GAUNTLET',
              createdAt: Date.now(),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await listPartyDirectory(2, 10);
    expect(capturedUrl).toContain('/api/v1/party/directory?page=2&limit=10');
    expect(res.totalRooms).toBe(1);
    expect(res.rooms[0]?.roomCode).toBe('PARTY9');
  });

  it('reconnects with session token and member id', async () => {
    let capturedBody: unknown = null;
    stubFetch(async (url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          success: true,
          roomSnapshot: mockRoom,
          restoredState: { ready: true },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await reconnectPartyRoom('PARTY9', 'token-123', 'member-1');
    expect(capturedBody).toEqual({
      sessionToken: 'token-123',
      memberId: 'member-1',
    });
    expect(res.success).toBe(true);
  });

  it('throws PartyApiError with parsed error message and code on error responses', async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Room code not found or expired',
            code: 'ROOM_NOT_FOUND',
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
    );

    await expect(getPartyRoomStatus('NONEXIST')).rejects.toThrow(PartyApiError);
    try {
      await getPartyRoomStatus('NONEXIST');
    } catch (err) {
      const apiErr = err as PartyApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toBe('Room code not found or expired');
      expect(apiErr.code).toBe('ROOM_NOT_FOUND');
    }
  });

  it('handles non-json error responses cleanly', async () => {
    stubFetch(
      async () =>
        new Response('Internal Server Error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );

    try {
      await getPartyRoomStatus('CRASH');
      expect.fail('Should have thrown');
    } catch (err) {
      const apiErr = err as PartyApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).toBe('HTTP 500');
    }
  });
});
