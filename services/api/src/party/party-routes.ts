import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RoomManager } from './room-manager';
import type { CreatePartyRoomInput, JoinPartyRoomInput, ReconnectPartyRoomInput } from './types';

export function registerPartyRoutes(app: FastifyInstance, roomManager: RoomManager): void {
  const prefixes = ['/api/v1/party', '/v1/party'];

  for (const prefix of prefixes) {
    // 1. Create Room
    app.post(`${prefix}/rooms`, async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as CreatePartyRoomInput;
      const result = roomManager.createRoom(body);
      return reply.code(201).send(result);
    });

    // 2. Discoverable Directory (MUST be registered before :code so 'directory' isn't treated as a code)
    app.get(`${prefix}/directory`, async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query ?? {}) as { page?: string; limit?: string };
      const page = query.page ? Number.parseInt(query.page, 10) : 1;
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 20;

      const result = roomManager.listPublicRooms(page, limit);
      return reply.code(200).send(result);
    });

    // 3. Resolve Room Status by Code
    app.get(`${prefix}/rooms/:code`, async (req: FastifyRequest, reply: FastifyReply) => {
      const { code } = req.params as { code: string };
      const summary = roomManager.getRoomSummary(code);

      if (!summary) {
        return reply.code(404).send({
          error: 'Room not found',
          code: 'ROOM_NOT_FOUND',
        });
      }

      return reply.code(200).send({
        roomId: summary.roomId,
        roomCode: summary.roomCode,
        title: summary.title,
        state: summary.state,
        memberCount: summary.memberCount,
        maxPlayers: summary.maxPlayers,
        isPrivate: summary.isPrivate,
        allowSpectators: summary.allowSpectators,
      });
    });

    // 4. Join Room
    app.post(`${prefix}/rooms/:code/join`, async (req: FastifyRequest, reply: FastifyReply) => {
      const { code } = req.params as { code: string };
      const body = (req.body ?? {}) as JoinPartyRoomInput;

      if (!body.displayName || typeof body.displayName !== 'string') {
        return reply.code(400).send({
          error: 'displayName is required',
          code: 'INVALID_DISPLAY_NAME',
        });
      }

      try {
        const result = roomManager.joinRoom(code, body);
        return reply.code(200).send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'ROOM_NOT_FOUND') {
          return reply.code(404).send({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
        }
        if (message === 'ROOM_FULL') {
          return reply
            .code(409)
            .send({ error: 'Room is at maximum player capacity', code: 'ROOM_FULL' });
        }
        if (message === 'SPECTATORS_NOT_ALLOWED') {
          return reply
            .code(403)
            .send({ error: 'Spectators not allowed in this room', code: 'SPECTATORS_NOT_ALLOWED' });
        }
        return reply.code(400).send({ error: message, code: 'JOIN_ERROR' });
      }
    });

    // 5. Reconnect to Room
    app.post(
      `${prefix}/rooms/:code/reconnect`,
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { code } = req.params as { code: string };
        const body = (req.body ?? {}) as ReconnectPartyRoomInput;

        if (!body.sessionToken || !body.memberId) {
          return reply.code(400).send({
            error: 'sessionToken and memberId are required',
            code: 'MISSING_RECONNECT_CREDENTIALS',
          });
        }

        try {
          const result = roomManager.reconnectMember(code, body);
          return reply.code(200).send(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'ROOM_NOT_FOUND' || message === 'MEMBER_NOT_FOUND') {
            return reply.code(404).send({ error: message, code: message });
          }
          if (message === 'INVALID_SESSION_TOKEN' || message === 'SESSION_TOKEN_MISMATCH') {
            return reply.code(401).send({ error: message, code: message });
          }
          return reply.code(400).send({ error: message, code: 'RECONNECT_ERROR' });
        }
      },
    );
  }
}
