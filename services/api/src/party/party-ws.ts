import { randomUUID } from 'node:crypto';
import { PARTY_RATE_LIMITS, type PartyOpCode } from '@playforge/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RoomManager } from './room-manager';
import { verifySessionToken } from './session-auth';

export interface MinimalWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (raw: Buffer | ArrayBuffer | string) => void): void;
  on(event: 'close' | 'error' | 'ping', listener: () => void): void;
}

export interface PartyConnectionContext {
  connectionId: string;
  socket: MinimalWebSocket;
  roomCode: string | null;
  memberId: string | null;
  lastPingAt: number;
  heartbeatInterval: NodeJS.Timeout | null;
}

export class PartyWebSocketGateway {
  private readonly connections = new Map<string, PartyConnectionContext>();

  constructor(
    private readonly roomManager: RoomManager,
    private readonly pingDropThresholdMs = PARTY_RATE_LIMITS.PING_DROP_THRESHOLD_MS,
  ) {}

  public handleConnection(
    socket: MinimalWebSocket,
    req?: FastifyRequest | { query?: Record<string, string | undefined> },
  ): PartyConnectionContext {
    const connectionId = randomUUID();
    const ctx: PartyConnectionContext = {
      connectionId,
      socket,
      roomCode: null,
      memberId: null,
      lastPingAt: Date.now(),
      heartbeatInterval: null,
    };

    this.connections.set(connectionId, ctx);

    // Setup 5s heartbeat monitor checking for 15s drop threshold
    ctx.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      if (now - ctx.lastPingAt >= this.pingDropThresholdMs) {
        this.closeConnection(ctx, 4000, 'Heartbeat timeout');
      }
    }, 5000);

    // Check query params for handshake authentication
    const query = (req?.query ?? {}) as Record<string, string | undefined>;
    const token = query['token'] || query['sessionToken'];
    const roomCodeParam = query['code'] || query['roomCode'];

    if (token) {
      this.authenticateAndAttach(ctx, token, roomCodeParam);
    }

    socket.on('message', (raw: Buffer | ArrayBuffer | string) => {
      ctx.lastPingAt = Date.now();

      // Check per-connection rate limit (max 20 msgs/sec)
      if (!this.roomManager.rateLimiter.checkSocketMessage(connectionId)) {
        this.sendError(
          socket,
          ctx.roomCode,
          'RATE_LIMIT_EXCEEDED',
          'Socket rate limit exceeded (max 20 messages/sec)',
        );
        return;
      }

      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(raw).toString('utf8');

      this.handleMessage(ctx, text);
    });

    socket.on('ping', () => {
      ctx.lastPingAt = Date.now();
      try {
        socket.send(JSON.stringify({ op: 'pong', timestamp: Date.now() }));
      } catch {
        // socket closed
      }
    });

    socket.on('close', () => {
      this.cleanupConnection(ctx);
    });

    socket.on('error', () => {
      this.cleanupConnection(ctx);
    });

    return ctx;
  }

  public handleMessage(ctx: PartyConnectionContext, text: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic incoming WebSocket payload
    let message: { op?: string; payload?: any };
    try {
      message = JSON.parse(text);
    } catch {
      this.sendError(ctx.socket, ctx.roomCode, 'INVALID_JSON', 'Malformed JSON payload');
      return;
    }

    const { op, payload } = message;

    if (op === 'ping' || op === 'party.ping') {
      try {
        ctx.socket.send(JSON.stringify({ op: 'pong', timestamp: Date.now() }));
      } catch {
        // ignore
      }
      return;
    }

    // Handshake / Reconnect
    if (op === 'party.join' || op === 'party.reconnect') {
      const token = payload?.sessionToken || payload?.token;
      const code = payload?.roomCode || payload?.code || ctx.roomCode;
      if (!token) {
        this.sendError(ctx.socket, code, 'MISSING_TOKEN', 'Session token is required');
        return;
      }
      this.authenticateAndAttach(ctx, token, code);
      return;
    }

    // Require attached roomCode and memberId for all remaining room actions
    if (!ctx.roomCode || !ctx.memberId) {
      this.sendError(
        ctx.socket,
        null,
        'UNAUTHORIZED',
        'Connection not authenticated with party room',
      );
      return;
    }

    try {
      switch (op) {
        case 'party.ready':
          this.roomManager.setPlayerReady(ctx.roomCode, ctx.memberId, Boolean(payload?.ready));
          break;

        case 'party.vote':
          if (!payload?.gameId) {
            this.sendError(
              ctx.socket,
              ctx.roomCode,
              'INVALID_PAYLOAD',
              'gameId is required for vote',
            );
            return;
          }
          this.roomManager.castVote(ctx.roomCode, ctx.memberId, payload.gameId);
          break;

        case 'party.veto':
          this.roomManager.triggerVeto(ctx.roomCode, ctx.memberId);
          break;

        case 'party.emoji':
          if (!payload?.emoji) {
            this.sendError(ctx.socket, ctx.roomCode, 'INVALID_PAYLOAD', 'emoji is required');
            return;
          }
          this.roomManager.sendEmoji(ctx.roomCode, ctx.memberId, payload.emoji);
          break;

        case 'party.sound':
          if (!payload?.soundId) {
            this.sendError(ctx.socket, ctx.roomCode, 'INVALID_PAYLOAD', 'soundId is required');
            return;
          }
          this.roomManager.sendSound(ctx.roomCode, ctx.memberId, payload.soundId);
          break;

        case 'party.chat':
          if (!payload?.text) return;
          this.roomManager.sendChat(ctx.roomCode, ctx.memberId, payload.text);
          break;

        case 'party.start_match':
          this.roomManager.startMatch(ctx.roomCode, ctx.memberId);
          break;

        case 'party.skip_intermission':
          this.roomManager.skipIntermission(ctx.roomCode, ctx.memberId);
          break;

        case 'party.submit_round_scores':
          if (!payload?.scores || typeof payload.scores !== 'object') {
            this.sendError(
              ctx.socket,
              ctx.roomCode,
              'INVALID_PAYLOAD',
              'scores object is required',
            );
            return;
          }
          this.roomManager.submitRoundScores(ctx.roomCode, payload.scores, ctx.memberId);
          break;

        case 'party.rematch':
          this.roomManager.requestRematch(ctx.roomCode, ctx.memberId);
          break;

        case 'party.kick_player':
          if (!payload?.targetMemberId) {
            this.sendError(
              ctx.socket,
              ctx.roomCode,
              'INVALID_PAYLOAD',
              'targetMemberId is required',
            );
            return;
          }
          this.roomManager.kickPlayer(ctx.roomCode, ctx.memberId, payload.targetMemberId);
          break;

        case 'party.leave':
          this.roomManager.leaveRoom(ctx.roomCode, ctx.memberId);
          this.closeConnection(ctx, 1000, 'Left room');
          break;

        default:
          this.sendError(ctx.socket, ctx.roomCode, 'UNKNOWN_OPCODE', `Opcode ${op} not recognized`);
          break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(ctx.socket, ctx.roomCode, 'PARTY_ERROR', message);
    }
  }

  private authenticateAndAttach(
    ctx: PartyConnectionContext,
    token: string,
    targetRoomCode?: string | null,
  ): boolean {
    const claims = verifySessionToken(token);
    if (!claims) {
      this.sendError(
        ctx.socket,
        targetRoomCode ?? null,
        'INVALID_SESSION_TOKEN',
        'Session token invalid or expired',
      );
      return false;
    }

    const room = this.roomManager.getRoom(claims.roomCode);
    if (!room) {
      this.sendError(ctx.socket, claims.roomCode, 'ROOM_NOT_FOUND', 'Room no longer exists');
      return false;
    }

    const member = room.members[claims.memberId];
    if (!member) {
      this.sendError(ctx.socket, claims.roomCode, 'MEMBER_NOT_FOUND', 'Player not found in room');
      return false;
    }

    // Attach
    ctx.roomCode = room.roomCode;
    ctx.memberId = member.id;

    // Register with RoomManager
    this.roomManager.registerSocket(room.roomCode, member.id, ctx.socket);

    // If member was in disconnected grace, restore them
    if (member.status === 'DISCONNECTED_GRACE') {
      this.roomManager.reconnectMember(room.roomCode, {
        sessionToken: token,
        memberId: member.id,
      });
    }

    // Send immediate snapshot to this member
    this.roomManager.sendToMember(room.roomCode, member.id, 'room.snapshot', { room });

    return true;
  }

  private sendError(
    socket: MinimalWebSocket,
    roomCode: string | null,
    code: string,
    message: string,
  ): void {
    const room = roomCode ? this.roomManager.getRoom(roomCode) : undefined;
    const payload = {
      op: 'room.error',
      seq: 0,
      timestamp: Date.now(),
      roomId: room?.roomId || '',
      payload: { code, message },
    };
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  private closeConnection(ctx: PartyConnectionContext, code: number, reason: string): void {
    try {
      ctx.socket.close(code, reason);
    } catch {
      // ignore
    }
    this.cleanupConnection(ctx);
  }

  private cleanupConnection(ctx: PartyConnectionContext): void {
    if (ctx.heartbeatInterval) {
      clearInterval(ctx.heartbeatInterval);
      ctx.heartbeatInterval = null;
    }

    if (ctx.roomCode && ctx.memberId) {
      this.roomManager.unregisterSocket(ctx.roomCode, ctx.memberId);
      this.roomManager.handleSocketDisconnect(ctx.roomCode, ctx.memberId);
    }

    this.roomManager.rateLimiter.cleanupConnection(ctx.connectionId);
    this.connections.delete(ctx.connectionId);
  }

  public destroy(): void {
    for (const ctx of this.connections.values()) {
      if (ctx.heartbeatInterval) {
        clearInterval(ctx.heartbeatInterval);
      }
      try {
        ctx.socket.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    this.connections.clear();
  }
}

function isFastifySocket(value: unknown): value is MinimalWebSocket {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { send?: unknown }).send === 'function' &&
    typeof (value as { close?: unknown }).close === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  );
}

function isFastifyRequest(value: unknown): value is FastifyRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { url?: unknown }).url === 'string' &&
    'headers' in value
  );
}

export function registerPartyWebSocket(
  app: FastifyInstance,
  roomManager: RoomManager,
  gateway?: PartyWebSocketGateway,
): PartyWebSocketGateway {
  const activeGateway = gateway || new PartyWebSocketGateway(roomManager);

  app.after(() => {
    app.get('/ws/party', { websocket: true }, (first: unknown, second: unknown) => {
      const socket = (
        isFastifySocket(first) ? first : isFastifySocket(second) ? second : null
      ) as MinimalWebSocket | null;
      const req = (
        isFastifyRequest(second) ? second : isFastifyRequest(first) ? first : null
      ) as FastifyRequest | null;

      if (!socket) return;
      activeGateway.handleConnection(socket, req || undefined);
    });
  });

  return activeGateway;
}
