import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinimalWebSocket } from './party-ws';
import { PartyWebSocketGateway } from './party-ws';
import { RoomManager } from './room-manager';

class MockWebSocket extends EventEmitter implements MinimalWebSocket {
  // biome-ignore lint/suspicious/noExplicitAny: test mock socket messages
  public sentMessages: any[] = [];
  public closed = false;
  public closeCode: number | undefined = undefined;
  public closeReason: string | undefined = undefined;

  send(data: string): void {
    if (this.closed) return;
    try {
      this.sentMessages.push(JSON.parse(data));
    } catch {
      this.sentMessages.push(data);
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  // biome-ignore lint/suspicious/noExplicitAny: test mock message payload
  simulateMessage(payload: any): void {
    this.emit('message', JSON.stringify(payload));
  }
}

describe('Party Mode WebSocket Gateway (/ws/party)', () => {
  let roomManager: RoomManager;
  let gateway: PartyWebSocketGateway;

  beforeEach(() => {
    vi.useFakeTimers();
    roomManager = new RoomManager({
      lobbyReadyCountdownSec: 5,
      votingWindowSec: 15,
      vetoWindowSec: 5,
      countdownTicks: 3,
      intermissionDurationSec: 10,
      disconnectGraceMs: 60000,
      hostMigrationGraceMs: 15000,
      pingDropThresholdMs: 15000,
    });
    gateway = new PartyWebSocketGateway(roomManager);
  });

  afterEach(() => {
    gateway.destroy();
    roomManager.destroy();
    vi.useRealTimers();
  });

  it('authenticates via query token and sends room.snapshot with monotonic seq', () => {
    const { roomCode, hostSessionToken, memberId, roomId } = roomManager.createRoom({
      hostName: 'HostPlayer',
    });

    const mockSocket = new MockWebSocket();
    gateway.handleConnection(mockSocket, {
      query: { token: hostSessionToken },
    });

    // Should receive room.snapshot immediately
    expect(mockSocket.sentMessages).toHaveLength(1);
    const snapshotMsg = mockSocket.sentMessages[0];
    expect(snapshotMsg.op).toBe('room.snapshot');
    expect(snapshotMsg.seq).toBe(1);
    expect(snapshotMsg.roomId).toBe(roomId);
    expect(snapshotMsg.payload.room.roomCode).toBe(roomCode);
    expect(snapshotMsg.payload.room.members[memberId].displayName).toBe('HostPlayer');
  });

  it('authenticates via party.join message and handles player events', () => {
    const { roomCode, hostSessionToken } = roomManager.createRoom({ hostName: 'Host' });
    const guest = roomManager.joinRoom(roomCode, { displayName: 'Guest' });

    const hostSocket = new MockWebSocket();
    const guestSocket = new MockWebSocket();

    gateway.handleConnection(hostSocket, { query: { token: hostSessionToken } });
    gateway.handleConnection(guestSocket);

    // Guest joins via message
    guestSocket.simulateMessage({
      op: 'party.join',
      payload: { sessionToken: guest.sessionToken, roomCode },
    });

    // Guest receives snapshot
    const guestSnapshot = guestSocket.sentMessages.find((m) => m.op === 'room.snapshot');
    expect(guestSnapshot).toBeDefined();

    // Guest toggles ready
    guestSocket.simulateMessage({
      op: 'party.ready',
      payload: { ready: true },
    });

    // Host should receive room.player_updated for guest
    const guestUpdated = hostSocket.sentMessages.find(
      (m) => m.op === 'room.player_updated' && m.payload.member.id === guest.memberId,
    );
    expect(guestUpdated).toBeDefined();
    expect(guestUpdated.payload.member.status).toBe('READY');
  });

  it('enforces 20 socket messages per second cap per connection', () => {
    const { roomCode, hostSessionToken } = roomManager.createRoom();
    const socket = new MockWebSocket();
    gateway.handleConnection(socket, { query: { token: hostSessionToken } });

    // Clear snapshot message
    socket.sentMessages = [];

    // Send 20 messages rapidly
    for (let i = 0; i < 20; i++) {
      socket.simulateMessage({ op: 'party.ready', payload: { ready: true } });
    }

    // 21st message in same second should trigger rate limit error
    socket.simulateMessage({ op: 'party.ready', payload: { ready: true } });

    const rateLimitError = socket.sentMessages.find(
      (m) => m.op === 'room.error' && m.payload.code === 'RATE_LIMIT_EXCEEDED',
    );
    expect(rateLimitError).toBeDefined();
  });

  it('enforces 3 emojis per second per player', () => {
    const { roomCode, hostSessionToken } = roomManager.createRoom();
    const socket = new MockWebSocket();
    gateway.handleConnection(socket, { query: { token: hostSessionToken } });

    socket.sentMessages = [];

    // Send 3 emojis
    socket.simulateMessage({ op: 'party.emoji', payload: { emoji: '🔥' } });
    socket.simulateMessage({ op: 'party.emoji', payload: { emoji: '🎉' } });
    socket.simulateMessage({ op: 'party.emoji', payload: { emoji: '🚀' } });

    // 4th emoji should fail
    socket.simulateMessage({ op: 'party.emoji', payload: { emoji: '😎' } });

    const errorMsg = socket.sentMessages.find(
      (m) => m.op === 'room.error' && m.payload.code === 'RATE_LIMIT_EXCEEDED',
    );
    expect(errorMsg).toBeDefined();
    expect(errorMsg.payload.message).toContain('Max 3 emojis');
  });

  it('enforces sound bite 4-second cooldown', () => {
    const { roomCode, hostSessionToken } = roomManager.createRoom({
      soundBitesEnabled: true,
    });
    const socket = new MockWebSocket();
    gateway.handleConnection(socket, { query: { token: hostSessionToken } });

    socket.sentMessages = [];

    // 1st sound passes
    socket.simulateMessage({ op: 'party.sound', payload: { soundId: 'airhorn' } });
    expect(socket.sentMessages.some((m) => m.op === 'broadcast.sound')).toBe(true);

    // 2nd sound within 4s fails
    socket.sentMessages = [];
    socket.simulateMessage({ op: 'party.sound', payload: { soundId: 'airhorn' } });

    const errorMsg = socket.sentMessages.find(
      (m) => m.op === 'room.error' && m.payload.code === 'RATE_LIMIT_EXCEEDED',
    );
    expect(errorMsg).toBeDefined();
  });

  it('broadcasts chat messages with sanitized content', () => {
    const { roomCode, hostSessionToken } = roomManager.createRoom();
    const guest = roomManager.joinRoom(roomCode, { displayName: 'Guest' });

    const hostSocket = new MockWebSocket();
    const guestSocket = new MockWebSocket();

    gateway.handleConnection(hostSocket, { query: { token: hostSessionToken } });
    gateway.handleConnection(guestSocket, { query: { token: guest.sessionToken } });

    guestSocket.simulateMessage({
      op: 'party.chat',
      payload: { text: 'Hello <script>bad()</script> world!' },
    });

    const chat = hostSocket.sentMessages.find((m) => m.op === 'broadcast.chat');
    expect(chat).toBeDefined();
    expect(chat.payload.text).toBe('Hello bad() world!');
  });

  it('drops socket when client fails to ping within 15 seconds', () => {
    const { roomCode, hostSessionToken, memberId } = roomManager.createRoom();
    const socket = new MockWebSocket();
    gateway.handleConnection(socket, { query: { token: hostSessionToken } });

    expect(socket.closed).toBe(false);

    // Advance 16 seconds without any message/ping from client
    vi.advanceTimersByTime(16000);

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(4000);
    expect(socket.closeReason).toBe('Heartbeat timeout');

    // Host should enter DISCONNECTED_GRACE
    expect(roomManager.getRoom(roomCode)!.members[memberId]?.status).toBe('DISCONNECTED_GRACE');
  });

  it('responds to ping with pong heartbeat', () => {
    const { hostSessionToken } = roomManager.createRoom();
    const socket = new MockWebSocket();
    gateway.handleConnection(socket, { query: { token: hostSessionToken } });

    socket.sentMessages = [];
    socket.simulateMessage({ op: 'ping' });

    const pong = socket.sentMessages.find((m) => m.op === 'pong');
    expect(pong).toBeDefined();
    expect(pong.timestamp).toBeDefined();
  });
});
