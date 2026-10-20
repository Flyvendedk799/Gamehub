import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPartyRoutes } from './party-routes';
import { RoomManager } from './room-manager';

describe('Party Mode REST Endpoints', () => {
  let app: FastifyInstance;
  let roomManager: RoomManager;

  beforeEach(async () => {
    roomManager = new RoomManager();
    app = Fastify();
    registerPartyRoutes(app, roomManager);
    await app.ready();
  });

  afterEach(async () => {
    roomManager.destroy();
    await app.close();
  });

  describe('POST /api/v1/party/rooms and /v1/party/rooms', () => {
    it('creates a room and returns Base32 code, session token, and room snapshot', async () => {
      for (const prefix of ['/api/v1/party', '/v1/party']) {
        const res = await app.inject({
          method: 'POST',
          url: `${prefix}/rooms`,
          payload: {
            title: 'Linus Arcade',
            maxPlayers: 8,
            playlistMode: 'POINTS_GAUNTLET',
            hostName: 'Linus',
          },
        });

        expect(res.statusCode).toBe(201);
        const json = res.json();
        expect(json.roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
        expect(json.roomId).toBeDefined();
        expect(json.hostSessionToken).toBeDefined();
        expect(json.memberId).toBeDefined();
        expect(json.room).toBeDefined();
        expect(json.room.title).toBe('Linus Arcade');
        expect(json.room.state).toBe('LOBBY');
        expect(json.room.members[json.memberId].displayName).toBe('Linus');
        expect(json.room.members[json.memberId].isHost).toBe(true);
        expect(json.room.members[json.memberId].role).toBe('HOST');
      }
    });
  });

  describe('GET /api/v1/party/rooms/:code', () => {
    it('resolves room summary by code', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { title: 'Game Room', maxPlayers: 6 },
      });
      const { roomCode, roomId } = createRes.json();

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/party/rooms/${roomCode}`,
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toEqual({
        roomId,
        roomCode,
        title: 'Game Room',
        state: 'LOBBY',
        memberCount: 1,
        maxPlayers: 6,
        isPrivate: false,
        allowSpectators: true,
      });
    });

    it('returns 404 for unknown room code', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/party/rooms/999999',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ROOM_NOT_FOUND');
    });
  });

  describe('POST /api/v1/party/rooms/:code/join', () => {
    it('allows guest to join with sanitized name and returns session token', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { hostName: 'HostPlayer' },
      });
      const { roomCode } = createRes.json();

      const joinRes = await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/join`,
        payload: {
          displayName: '<script>alert("hacked")</script>PlayerOne',
          avatarId: 'avatar-cat',
          avatarColor: '#22c55e',
        },
      });

      expect(joinRes.statusCode).toBe(200);
      const json = joinRes.json();
      expect(json.memberId).toBeDefined();
      expect(json.sessionToken).toBeDefined();
      expect(json.wsEndpoint).toBe('/ws/party');
      expect(json.room.members[json.memberId].displayName).toBe('PlayerOne');
      expect(json.room.members[json.memberId].avatarId).toBe('avatar-cat');
      expect(json.room.members[json.memberId].role).toBe('PLAYER');
    });

    it('handles name collision with conflict resolution (e.g., Name (2))', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { hostName: 'Player' },
      });
      const { roomCode } = createRes.json();

      const join1 = await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/join`,
        payload: { displayName: 'Player' },
      });
      expect(join1.json().room.members[join1.json().memberId].displayName).toBe('Player (2)');

      const join2 = await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/join`,
        payload: { displayName: 'Player' },
      });
      expect(join2.json().room.members[join2.json().memberId].displayName).toBe('Player (3)');
    });

    it('rejects joining when room is full and spectators are disallowed', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { maxPlayers: 2, allowSpectators: false },
      });
      const { roomCode } = createRes.json();

      // 2nd player joins
      await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/join`,
        payload: { displayName: 'Player 2' },
      });

      // 3rd player exceeds capacity
      const failRes = await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/join`,
        payload: { displayName: 'Player 3' },
      });

      expect(failRes.statusCode).toBe(409);
      expect(failRes.json().code).toBe('ROOM_FULL');
    });
  });

  describe('GET /api/v1/party/directory', () => {
    it('returns discoverable public rooms with pagination', async () => {
      // Create 3 public rooms and 1 private room
      await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { title: 'Public 1', isPrivate: false },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { title: 'Public 2', isPrivate: false },
      });
      await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { title: 'Private 1', isPrivate: true },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/party/directory?page=1&limit=2',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.totalRooms).toBe(2);
      expect(json.rooms).toHaveLength(2);
      expect(json.rooms.every((r: { isPrivate: boolean }) => !r.isPrivate)).toBe(true);
    });
  });

  describe('POST /api/v1/party/rooms/:code/reconnect', () => {
    it('validates session token and restores connection status', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
        payload: { hostName: 'Host' },
      });
      const { roomCode, hostSessionToken, memberId } = createRes.json();

      // Disconnect host
      roomManager.handleSocketDisconnect(roomCode, memberId);
      expect(roomManager.getRoom(roomCode)!.members[memberId]?.status).toBe('DISCONNECTED_GRACE');

      // Reconnect via REST endpoint
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/reconnect`,
        payload: { sessionToken: hostSessionToken, memberId },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.restoredState.status).toBe('CONNECTED');
      expect(json.roomSnapshot.members[memberId].status).toBe('CONNECTED');
    });

    it('rejects invalid or forged session tokens with 401', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/party/rooms',
      });
      const { roomCode, memberId } = createRes.json();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/party/rooms/${roomCode}/reconnect`,
        payload: { sessionToken: 'invalid.token', memberId },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('INVALID_SESSION_TOKEN');
    });
  });
});
