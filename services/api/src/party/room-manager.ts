import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PARTY_MINIGAMES,
  type GameVoteOption,
  type PartyMember,
  type PartyOpCode,
  type PartyRoom,
  type PartyRoomSummary,
  type PartySocketMessage,
  type PlayerRole,
  type PlayerStatus,
  type PlaylistConfig,
  type PlaylistMode,
  type RoomState,
  type SelectionStrategy,
} from '@playforge/shared';
import { generateRoomCode, normalizeRoomCode } from './code-generator';
import { PartyRateLimiter } from './rate-limiter';
import { createSessionToken, verifySessionToken } from './session-auth';
import type {
  CreatePartyRoomInput,
  JoinPartyRoomInput,
  ReconnectPartyRoomInput,
  RoomTimerOptions,
} from './types';
import {
  type PlayerGameStats,
  calculateGrandPrixPoints,
  calculatePodium,
  filterProfanity,
  sanitizeDisplayName,
} from './utils';

export interface WebSocketSender {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class RoomManager {
  private readonly rooms = new Map<string, PartyRoom>(); // roomCode -> PartyRoom
  private readonly roomCodeById = new Map<string, string>(); // roomId -> roomCode
  private readonly sockets = new Map<string, Map<string, WebSocketSender>>(); // roomCode -> (memberId -> WebSocketSender)
  private readonly seqCounters = new Map<string, number>(); // roomCode -> monotonic sequence
  private readonly stats = new Map<string, Record<string, PlayerGameStats>>(); // roomCode -> (memberId -> stats)

  // Active timers
  private readonly disconnectGraceTimers = new Map<string, NodeJS.Timeout>(); // "roomCode:memberId" -> Timeout
  private readonly hostMigrationTimers = new Map<string, NodeJS.Timeout>(); // roomCode -> Timeout
  private readonly activeFsmTimers = new Map<string, NodeJS.Timeout>(); // roomCode -> Timeout

  public readonly rateLimiter: PartyRateLimiter;
  private readonly timerOptions: Required<RoomTimerOptions>;

  constructor(timerOptions?: RoomTimerOptions) {
    this.rateLimiter = new PartyRateLimiter();
    this.timerOptions = {
      lobbyReadyCountdownSec: timerOptions?.lobbyReadyCountdownSec ?? 5,
      votingWindowSec: timerOptions?.votingWindowSec ?? 15,
      vetoWindowSec: timerOptions?.vetoWindowSec ?? 5,
      countdownTicks: timerOptions?.countdownTicks ?? 3,
      intermissionDurationSec: timerOptions?.intermissionDurationSec ?? 10,
      disconnectGraceMs: timerOptions?.disconnectGraceMs ?? 60000,
      hostMigrationGraceMs: timerOptions?.hostMigrationGraceMs ?? 15000,
      pingDropThresholdMs: timerOptions?.pingDropThresholdMs ?? 15000,
    };
  }

  // ── Sequence & Broadcast ──────────────────────────────────────────────────

  private nextSeq(roomCode: string): number {
    const current = (this.seqCounters.get(roomCode) ?? 0) + 1;
    this.seqCounters.set(roomCode, current);
    return current;
  }

  public broadcast<T>(roomCode: string, op: PartyOpCode, payload: T): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const seq = this.nextSeq(roomCode);
    const message: PartySocketMessage<T> = {
      op,
      seq,
      timestamp: Date.now(),
      roomId: room.roomId,
      payload,
    };
    const serialized = JSON.stringify(message);

    const roomSockets = this.sockets.get(roomCode);
    if (!roomSockets) return;

    for (const [memberId, socket] of roomSockets.entries()) {
      try {
        socket.send(serialized);
      } catch {
        // Socket send error; handled by disconnect
      }
    }
  }

  public sendToMember<T>(roomCode: string, memberId: string, op: PartyOpCode, payload: T): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const seq = this.nextSeq(roomCode);
    const message: PartySocketMessage<T> = {
      op,
      seq,
      timestamp: Date.now(),
      roomId: room.roomId,
      payload,
    };
    const socket = this.sockets.get(roomCode)?.get(memberId);
    if (socket) {
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // Handled on close
      }
    }
  }

  // ── Room Queries ──────────────────────────────────────────────────────────

  public getRoom(codeOrId: string): PartyRoom | undefined {
    const normalized = normalizeRoomCode(codeOrId);
    if (this.rooms.has(normalized)) {
      return this.rooms.get(normalized);
    }
    const code = this.roomCodeById.get(codeOrId);
    return code ? this.rooms.get(code) : undefined;
  }

  public getRoomSummary(codeOrId: string): PartyRoomSummary | undefined {
    const room = this.getRoom(codeOrId);
    if (!room) return undefined;
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      title: room.title,
      state: room.state,
      memberCount: Object.keys(room.members).length,
      maxPlayers: room.maxActivePlayers,
      isPrivate: room.isPrivate,
      allowSpectators: room.allowSpectators,
      playlistMode: room.playlist.mode,
      createdAt: room.createdAt,
    };
  }

  public listPublicRooms(page = 1, limit = 20): { totalRooms: number; rooms: PartyRoomSummary[] } {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    const publicRooms = Array.from(this.rooms.values())
      .filter((r) => !r.isPrivate)
      .sort((a, b) => b.createdAt - a.createdAt);

    const totalRooms = publicRooms.length;
    const offset = (safePage - 1) * safeLimit;
    const paged = publicRooms.slice(offset, offset + safeLimit).map((room) => ({
      roomId: room.roomId,
      roomCode: room.roomCode,
      title: room.title,
      state: room.state,
      memberCount: Object.keys(room.members).length,
      maxPlayers: room.maxActivePlayers,
      isPrivate: room.isPrivate,
      allowSpectators: room.allowSpectators,
      playlistMode: room.playlist.mode,
      createdAt: room.createdAt,
    }));

    return { totalRooms, rooms: paged };
  }

  // ── Room Lifecycle ────────────────────────────────────────────────────────

  public createRoom(input: CreatePartyRoomInput = {}): {
    roomCode: string;
    roomId: string;
    hostSessionToken: string;
    memberId: string;
    room: PartyRoom;
  } {
    const roomCode = generateRoomCode((code) => this.rooms.has(code));
    const roomId = randomUUID();
    const hostMemberId = randomUUID();
    const now = Date.now();

    const hostName = sanitizeDisplayName(input.hostName || 'Host', []);
    const hostAvatarId = input.avatarId || input.hostAvatarId || 'avatar-1';
    const hostAvatarColor = input.avatarColor || input.hostAvatarColor || '#3b82f6';

    const hostMember: PartyMember = {
      id: hostMemberId,
      displayName: hostName,
      avatarId: hostAvatarId,
      avatarColor: hostAvatarColor,
      role: 'HOST',
      status: 'CONNECTED',
      isHost: true,
      score: 0,
      currentRoundScore: 0,
      hasVetoAvailable: true,
      pingMs: 20,
      joinedAt: now,
    };

    const playlistMode: PlaylistMode = input.playlistMode || 'POINTS_GAUNTLET';
    const totalRounds =
      playlistMode === 'SINGLE_GAME'
        ? 1
        : playlistMode === 'BEST_OF_3'
          ? 3
          : playlistMode === 'BEST_OF_5'
            ? 5
            : (input.totalRounds ?? 5);

    const playlist: PlaylistConfig = {
      mode: playlistMode,
      totalRounds,
      currentRoundIndex: 0,
      selectionStrategy: input.selectionStrategy || 'DEMOCRATIC_VOTE',
      intermissionDurationSec: this.timerOptions.intermissionDurationSec,
    };

    const room: PartyRoom = {
      roomId,
      roomCode,
      title: input.title?.trim() || `${hostName}'s Party`,
      isPrivate: input.isPrivate ?? false,
      maxActivePlayers: Math.min(16, Math.max(2, input.maxPlayers ?? 8)),
      allowSpectators: input.allowSpectators ?? true,
      soundBitesEnabled: input.soundBitesEnabled ?? true,
      state: 'LOBBY',
      hostId: hostMemberId,
      members: { [hostMemberId]: hostMember },
      playlist,
      createdAt: now,
      updatedAt: now,
    };

    this.rooms.set(roomCode, room);
    this.roomCodeById.set(roomId, roomCode);
    this.seqCounters.set(roomCode, 0);
    this.stats.set(roomCode, {
      [hostMemberId]: {
        memberId: hostMemberId,
        roundScores: [],
        vetoTriggered: false,
        emojisSent: 0,
        soundsSent: 0,
        fourthPlaceCount: 0,
      },
    });

    const hostSessionToken = createSessionToken(roomId, roomCode, hostMemberId, 'HOST');

    return {
      roomCode,
      roomId,
      hostSessionToken,
      memberId: hostMemberId,
      room,
    };
  }

  public joinRoom(
    codeOrId: string,
    input: JoinPartyRoomInput,
  ): {
    memberId: string;
    sessionToken: string;
    wsEndpoint: string;
    room: PartyRoom;
  } {
    const room = this.getRoom(codeOrId);
    if (!room) {
      throw new Error('ROOM_NOT_FOUND');
    }

    const existingNames = Object.values(room.members).map((m) => m.displayName);
    const sanitizedName = sanitizeDisplayName(input.displayName, existingNames);

    const activePlayers = Object.values(room.members).filter((m) => m.role !== 'SPECTATOR');
    const isAtPlayerCapacity = activePlayers.length >= room.maxActivePlayers;

    let role: PlayerRole = 'PLAYER';
    if (input.rolePreference === 'SPECTATOR') {
      if (!room.allowSpectators) {
        throw new Error('SPECTATORS_NOT_ALLOWED');
      }
      role = 'SPECTATOR';
    } else if (isAtPlayerCapacity) {
      if (!room.allowSpectators) {
        throw new Error('ROOM_FULL');
      }
      role = 'SPECTATOR';
    }

    const memberId = randomUUID();
    const now = Date.now();

    const member: PartyMember = {
      id: memberId,
      displayName: sanitizedName,
      avatarId: input.avatarId || 'avatar-2',
      avatarColor: input.avatarColor || '#10b981',
      role,
      status: 'CONNECTED',
      isHost: false,
      score: 0,
      currentRoundScore: 0,
      hasVetoAvailable: true,
      pingMs: 20,
      joinedAt: now,
    };

    room.members[memberId] = member;
    room.updatedAt = now;

    const roomStats = this.stats.get(room.roomCode);
    if (roomStats) {
      roomStats[memberId] = {
        memberId,
        roundScores: [],
        vetoTriggered: false,
        emojisSent: 0,
        soundsSent: 0,
        fourthPlaceCount: 0,
      };
    }

    const sessionToken = createSessionToken(room.roomId, room.roomCode, memberId, role);

    this.broadcast(room.roomCode, 'room.player_joined', { member });

    return {
      memberId,
      sessionToken,
      wsEndpoint: '/ws/party',
      room,
    };
  }

  public reconnectMember(
    codeOrId: string,
    input: ReconnectPartyRoomInput,
  ): {
    success: boolean;
    roomSnapshot: PartyRoom;
    restoredState: { status: PlayerStatus };
  } {
    const room = this.getRoom(codeOrId);
    if (!room) {
      throw new Error('ROOM_NOT_FOUND');
    }

    const claims = verifySessionToken(input.sessionToken);
    if (!claims) {
      throw new Error('INVALID_SESSION_TOKEN');
    }

    if (claims.roomId !== room.roomId || claims.memberId !== input.memberId) {
      throw new Error('SESSION_TOKEN_MISMATCH');
    }

    const member = room.members[input.memberId];
    if (!member) {
      throw new Error('MEMBER_NOT_FOUND');
    }

    // Cancel 60s disconnect grace timer
    const graceKey = `${room.roomCode}:${member.id}`;
    const graceTimer = this.disconnectGraceTimers.get(graceKey);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.disconnectGraceTimers.delete(graceKey);
    }

    // If host was waiting for migration grace, cancel it
    if (member.isHost) {
      const hostTimer = this.hostMigrationTimers.get(room.roomCode);
      if (hostTimer) {
        clearTimeout(hostTimer);
        this.hostMigrationTimers.delete(room.roomCode);
      }
    }

    member.status = 'CONNECTED';
    member.disconnectedAt = undefined;
    room.updatedAt = Date.now();

    // Check if room lacks a connected host
    const currentHost = room.members[room.hostId];
    const hasConnectedHost = currentHost?.isHost && currentHost.status !== 'DISCONNECTED_GRACE';
    if (!hasConnectedHost) {
      if (currentHost && currentHost.id !== member.id) {
        currentHost.isHost = false;
        currentHost.role = 'PLAYER';
      }
      member.isHost = true;
      member.role = 'HOST';
      room.hostId = member.id;
      this.broadcast(room.roomCode, 'room.host_migrated', {
        previousHostId: currentHost?.id ?? '',
        newHostId: member.id,
      });
    }

    this.broadcast(room.roomCode, 'room.player_updated', { member });

    return {
      success: true,
      roomSnapshot: room,
      restoredState: { status: member.status },
    };
  }

  public leaveRoom(codeOrId: string, memberId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room) return;

    const member = room.members[memberId];
    if (!member) return;

    // Cleanup timers and socket
    const graceKey = `${room.roomCode}:${memberId}`;
    const graceTimer = this.disconnectGraceTimers.get(graceKey);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.disconnectGraceTimers.delete(graceKey);
    }

    const wasHost = member.isHost || room.hostId === memberId;
    if (wasHost) {
      const hostTimer = this.hostMigrationTimers.get(room.roomCode);
      if (hostTimer) {
        clearTimeout(hostTimer);
        this.hostMigrationTimers.delete(room.roomCode);
      }
    }

    this.unregisterSocket(room.roomCode, memberId);
    this.rateLimiter.cleanupMember(memberId);
    delete room.members[memberId];
    room.updatedAt = Date.now();

    this.broadcast(room.roomCode, 'room.player_left', {
      memberId,
      reason: 'voluntary_departure',
    });

    // Check if room is empty before migration
    if (Object.keys(room.members).length === 0) {
      this.cleanupRoom(room.roomCode);
      return;
    }

    // If host left, trigger immediate host migration
    if (wasHost) {
      this.migrateHostImmediately(room.roomCode, memberId);
    }
  }

  public kickPlayer(codeOrId: string, hostMemberId: string, targetMemberId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room) throw new Error('ROOM_NOT_FOUND');

    this.verifyHostAuthority(room, hostMemberId);

    const target = room.members[targetMemberId];
    if (!target) throw new Error('TARGET_NOT_FOUND');
    if (target.isHost) throw new Error('CANNOT_KICK_HOST');

    const socket = this.sockets.get(room.roomCode)?.get(targetMemberId);
    if (socket) {
      try {
        socket.close(4001, 'Kicked by host');
      } catch {
        // ignore
      }
    }

    delete room.members[targetMemberId];
    room.updatedAt = Date.now();

    this.broadcast(room.roomCode, 'room.player_left', {
      memberId: targetMemberId,
      reason: 'kicked',
    });
  }

  // ── Connection & Grace Period ─────────────────────────────────────────────

  public handleSocketDisconnect(codeOrId: string, memberId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room) return;

    const member = room.members[memberId];
    if (!member) return;

    member.status = 'DISCONNECTED_GRACE';
    member.disconnectedAt = Date.now();
    room.updatedAt = Date.now();

    this.broadcast(room.roomCode, 'room.player_updated', { member });

    // Start 60-second disconnect grace window
    const graceKey = `${room.roomCode}:${memberId}`;
    if (this.disconnectGraceTimers.has(graceKey)) {
      clearTimeout(this.disconnectGraceTimers.get(graceKey)!);
    }

    const graceTimer = setTimeout(() => {
      this.disconnectGraceTimers.delete(graceKey);
      if (room.members[memberId]?.status === 'DISCONNECTED_GRACE') {
        const wasHost = room.members[memberId].isHost || room.hostId === memberId;
        this.rateLimiter.cleanupMember(memberId);
        delete room.members[memberId];
        room.updatedAt = Date.now();

        this.broadcast(room.roomCode, 'room.player_left', {
          memberId,
          reason: 'grace_expired',
        });

        if (Object.keys(room.members).length === 0) {
          this.cleanupRoom(room.roomCode);
          return;
        }

        if (wasHost) {
          this.migrateHostImmediately(room.roomCode, memberId);
        }
      }
    }, this.timerOptions.disconnectGraceMs);

    this.disconnectGraceTimers.set(graceKey, graceTimer);

    // If host dropped unexpectedly, start 15s host migration grace timer
    if (member.isHost) {
      if (this.hostMigrationTimers.has(room.roomCode)) {
        clearTimeout(this.hostMigrationTimers.get(room.roomCode)!);
      }

      const hostTimer = setTimeout(() => {
        this.hostMigrationTimers.delete(room.roomCode);
        if (room.members[memberId]?.status === 'DISCONNECTED_GRACE') {
          this.migrateHostImmediately(room.roomCode, memberId);
        }
      }, this.timerOptions.hostMigrationGraceMs);

      this.hostMigrationTimers.set(room.roomCode, hostTimer);
    }
  }

  private migrateHostImmediately(roomCode: string, previousHostId: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const hostTimer = this.hostMigrationTimers.get(roomCode);
    if (hostTimer) {
      clearTimeout(hostTimer);
      this.hostMigrationTimers.delete(roomCode);
    }

    const eligible = Object.values(room.members).filter(
      (m) => m.id !== previousHostId && m.status !== 'DISCONNECTED_GRACE',
    );

    if (eligible.length === 0) {
      // If everyone is disconnected or no one left, cannot migrate yet
      return;
    }

    // Prioritize connected CO_HOST, then oldest connected PLAYER (lowest joinedAt)
    let newHost = eligible.find((m) => m.role === 'CO_HOST');
    if (!newHost) {
      const players = eligible
        .filter((m) => m.role === 'PLAYER')
        .sort((a, b) => a.joinedAt - b.joinedAt);
      newHost = players[0] || eligible[0];
    }

    if (!newHost) {
      return;
    }

    if (room.members[previousHostId]) {
      room.members[previousHostId].isHost = false;
      room.members[previousHostId].role = 'PLAYER';
    }

    newHost.isHost = true;
    newHost.role = 'HOST';
    room.hostId = newHost.id;
    room.updatedAt = Date.now();

    this.broadcast(room.roomCode, 'room.host_migrated', {
      previousHostId,
      newHostId: newHost.id,
    });
    this.broadcast(room.roomCode, 'room.player_updated', { member: newHost });
  }

  private verifyHostAuthority(room: PartyRoom, memberId: string): void {
    const caller = room.members[memberId];
    const isHost = caller && (caller.isHost || caller.role === 'HOST') && room.hostId === memberId;
    const isCoHost = caller && caller.role === 'CO_HOST';
    if (!caller || (!isHost && !isCoHost)) {
      throw new Error('UNAUTHORIZED');
    }
  }

  // ── FSM & Gameplay Lifecycle ──────────────────────────────────────────────

  public setPlayerReady(codeOrId: string, memberId: string, ready: boolean): void {
    const room = this.getRoom(codeOrId);
    if (!room || room.state !== 'LOBBY') return;

    const member = room.members[memberId];
    if (!member || member.role === 'SPECTATOR') return;

    member.status = ready ? 'READY' : 'NOT_READY';
    room.updatedAt = Date.now();

    this.broadcast(room.roomCode, 'room.player_updated', { member });

    // Check 100% active players ready
    const activeMembers = Object.values(room.members).filter((m) => m.role !== 'SPECTATOR');
    const allReady = activeMembers.length >= 2 && activeMembers.every((m) => m.status === 'READY');

    if (allReady) {
      this.startLobbyCountdown(room.roomCode);
    } else {
      this.cancelFsmTimer(room.roomCode);
    }
  }

  public startMatch(codeOrId: string, hostMemberId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room) throw new Error('ROOM_NOT_FOUND');

    this.verifyHostAuthority(room, hostMemberId);

    if (room.state !== 'LOBBY') {
      throw new Error('INVALID_ROOM_STATE');
    }

    this.cancelFsmTimer(room.roomCode);
    this.transitionToGameSelectVoting(room.roomCode);
  }

  private startLobbyCountdown(roomCode: string): void {
    this.cancelFsmTimer(roomCode);

    const timer = setTimeout(() => {
      this.transitionToGameSelectVoting(roomCode);
    }, this.timerOptions.lobbyReadyCountdownSec * 1000);

    this.activeFsmTimers.set(roomCode, timer);
  }

  public transitionToGameSelectVoting(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    this.cancelFsmTimer(roomCode);
    room.state = 'GAME_SELECT_VOTING';

    // Pick 3 candidate minigames
    const available = [...DEFAULT_PARTY_MINIGAMES];
    const shuffled = available.sort(() => 0.5 - Math.random());
    const candidates = shuffled.slice(0, 3);

    const options: GameVoteOption[] = candidates.map((c) => ({
      ...c,
      voteCount: 0,
      voterIds: [],
    }));

    const now = Date.now();
    const expiresAt = now + this.timerOptions.votingWindowSec * 1000;

    room.votingState = {
      roundIndex: room.playlist.currentRoundIndex,
      expiresAt,
      options,
    };
    room.updatedAt = now;

    this.broadcast(roomCode, 'room.state_changed', { state: 'GAME_SELECT_VOTING' });
    this.broadcast(roomCode, 'voting.started', { votingState: room.votingState });

    // Start 15s voting countdown
    let remainingSec = this.timerOptions.votingWindowSec;
    const interval = setInterval(() => {
      remainingSec--;
      if (remainingSec > 0) {
        this.broadcast(roomCode, 'voting.tick', {
          remainingSec,
          options: room.votingState?.options ?? [],
        });
      } else {
        clearInterval(interval);
        this.resolveVoting(roomCode);
      }
    }, 1000);

    this.activeFsmTimers.set(roomCode, interval as unknown as NodeJS.Timeout);
  }

  public castVote(codeOrId: string, memberId: string, gameId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room || room.state !== 'GAME_SELECT_VOTING' || !room.votingState) {
      throw new Error('INVALID_VOTE_STATE');
    }

    const member = room.members[memberId];
    if (!member || member.role === 'SPECTATOR') {
      throw new Error('SPECTATORS_CANNOT_VOTE');
    }

    for (const opt of room.votingState.options) {
      opt.voterIds = opt.voterIds.filter((id) => id !== memberId);
      if (opt.gameId === gameId) {
        opt.voterIds.push(memberId);
      }
      opt.voteCount = opt.voterIds.length;
    }

    room.updatedAt = Date.now();
    this.broadcast(room.roomCode, 'voting.tick', {
      remainingSec: Math.max(0, Math.ceil((room.votingState.expiresAt - Date.now()) / 1000)),
      options: room.votingState.options,
    });
  }

  public triggerVeto(
    codeOrId: string,
    memberId: string,
  ): { originalGameId: string; vetoedGameId: string } {
    const room = this.getRoom(codeOrId);
    if (!room || room.state !== 'GAME_SELECT_VOTING' || !room.votingState) {
      throw new Error('INVALID_VETO_STATE');
    }

    const member = room.members[memberId];
    if (!member || !member.hasVetoAvailable) {
      throw new Error('NO_VETO_AVAILABLE');
    }

    member.hasVetoAvailable = false;
    const stats = this.stats.get(room.roomCode)?.[memberId];
    if (stats) stats.vetoTriggered = true;

    // Rank options by vote count
    const sorted = [...room.votingState.options].sort((a, b) => b.voteCount - a.voteCount);
    const topOption = sorted[0];
    if (!topOption) {
      throw new Error('NO_OPTIONS_TO_VETO');
    }
    const originalGameId = topOption.gameId;
    // Replace with runner-up
    const runnerUp = sorted[1] || sorted[2] || topOption;
    const vetoedGameId = runnerUp.gameId;

    room.votingState.vetoTriggeredBy = {
      memberId,
      originalGameId,
      vetoedGameId,
    };
    room.updatedAt = Date.now();

    this.broadcast(room.roomCode, 'room.player_updated', { member });
    this.broadcast(room.roomCode, 'voting.tick', {
      remainingSec: Math.max(0, Math.ceil((room.votingState.expiresAt - Date.now()) / 1000)),
      options: room.votingState.options,
      vetoTriggeredBy: room.votingState.vetoTriggeredBy,
    });

    return { originalGameId, vetoedGameId };
  }

  public resolveVoting(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room || !room.votingState) return;

    this.cancelFsmTimer(roomCode);

    let winningGameId: string;
    if (room.votingState.vetoTriggeredBy) {
      winningGameId = room.votingState.vetoTriggeredBy.vetoedGameId;
    } else {
      const sorted = [...room.votingState.options].sort((a, b) => b.voteCount - a.voteCount);
      winningGameId = sorted[0]?.gameId || 'neon-racer';
    }

    room.activeMinigameId = winningGameId;
    room.updatedAt = Date.now();

    this.broadcast(roomCode, 'voting.resolved', {
      winningGameId,
      vetoTriggered: !!room.votingState.vetoTriggeredBy,
    });

    this.transitionToCountdown(roomCode);
  }

  public transitionToCountdown(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    this.cancelFsmTimer(roomCode);
    room.state = 'COUNTDOWN';
    room.updatedAt = Date.now();

    this.broadcast(roomCode, 'room.state_changed', { state: 'COUNTDOWN' });

    let count = this.timerOptions.countdownTicks;
    this.broadcast(roomCode, 'countdown.tick', { count });

    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        this.broadcast(roomCode, 'countdown.tick', { count });
      } else {
        clearInterval(interval);
        this.transitionToInGame(roomCode);
      }
    }, 1000);

    this.activeFsmTimers.set(roomCode, interval as unknown as NodeJS.Timeout);
  }

  public transitionToInGame(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    this.cancelFsmTimer(roomCode);
    room.state = 'IN_GAME';
    room.updatedAt = Date.now();

    this.broadcast(roomCode, 'room.state_changed', { state: 'IN_GAME' });
    this.broadcast(roomCode, 'game.launch', {
      gameId: room.activeMinigameId,
      roundIndex: room.playlist.currentRoundIndex,
    });
  }

  public submitRoundScores(
    codeOrId: string,
    scores: Record<string, number>,
    callerMemberId?: string,
  ): void {
    const room = this.getRoom(codeOrId);
    if (!room || room.state !== 'IN_GAME') {
      throw new Error('INVALID_SCORE_SUBMISSION_STATE');
    }

    if (callerMemberId) {
      this.verifyHostAuthority(room, callerMemberId);
    }

    const activeMembers = Object.values(room.members).filter((m) => m.role !== 'SPECTATOR');
    const eligibleIds = activeMembers.map((m) => m.id);

    // Calculate Grand Prix points
    const points = calculateGrandPrixPoints(scores, eligibleIds);

    const roomStats = this.stats.get(room.roomCode);
    for (const member of activeMembers) {
      const rawRoundScore = scores[member.id] ?? 0;
      const roundGrandPrixPoints = points[member.id] ?? 0;
      member.currentRoundScore = roundGrandPrixPoints;
      member.score += roundGrandPrixPoints;

      const pStats = roomStats ? roomStats[member.id] : undefined;
      if (pStats) {
        pStats.roundScores.push(rawRoundScore);
        if (roundGrandPrixPoints === 3) {
          pStats.fourthPlaceCount++;
        }
      }
    }

    room.updatedAt = Date.now();
    this.transitionToRoundOver(room.roomCode, scores, points);
  }

  private transitionToRoundOver(
    roomCode: string,
    roundScores: Record<string, number>,
    grandPrixPoints: Record<string, number>,
  ): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    this.cancelFsmTimer(roomCode);
    room.state = 'ROUND_OVER';
    room.updatedAt = Date.now();

    this.broadcast(roomCode, 'room.state_changed', { state: 'ROUND_OVER' });
    this.broadcast(roomCode, 'round.finished', {
      roundIndex: room.playlist.currentRoundIndex,
      roundScores,
      grandPrixPoints,
      cumulativeScores: Object.fromEntries(Object.values(room.members).map((m) => [m.id, m.score])),
    });

    // 10s intermission countdown
    const intermissionTimer = setTimeout(() => {
      this.advancePlaylistOrPodium(roomCode);
    }, this.timerOptions.intermissionDurationSec * 1000);

    this.activeFsmTimers.set(roomCode, intermissionTimer);
  }

  public skipIntermission(codeOrId: string, hostMemberId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room || room.state !== 'ROUND_OVER') return;

    this.verifyHostAuthority(room, hostMemberId);

    this.cancelFsmTimer(room.roomCode);
    this.advancePlaylistOrPodium(room.roomCode);
  }

  public advancePlaylistOrPodium(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    this.cancelFsmTimer(roomCode);
    const nextRoundIndex = room.playlist.currentRoundIndex + 1;
    const isFinished = nextRoundIndex >= room.playlist.totalRounds;

    if (isFinished) {
      this.transitionToPodium(roomCode);
    } else {
      room.playlist.currentRoundIndex = nextRoundIndex;
      for (const m of Object.values(room.members)) {
        m.currentRoundScore = 0;
      }
      this.transitionToGameSelectVoting(roomCode);
    }
  }

  public transitionToPodium(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    this.cancelFsmTimer(roomCode);
    room.state = 'PODIUM_CELEBRATION';

    const roomStats = this.stats.get(roomCode) || {};
    const { podiumPlacements, superlatives } = calculatePodium(room.members, roomStats);

    room.podiumState = {
      podiumPlacements,
      superlatives,
      rematchAvailable: true,
    };
    room.updatedAt = Date.now();

    this.broadcast(roomCode, 'room.state_changed', { state: 'PODIUM_CELEBRATION' });
    this.broadcast(roomCode, 'podium.announced', { podiumState: room.podiumState });
  }

  public requestRematch(codeOrId: string, hostMemberId?: string): void {
    const room = this.getRoom(codeOrId);
    if (!room || room.state !== 'PODIUM_CELEBRATION') return;

    if (hostMemberId) {
      this.verifyHostAuthority(room, hostMemberId);
    }

    this.cancelFsmTimer(room.roomCode);
    room.state = 'LOBBY';
    room.activeMinigameId = undefined;
    room.votingState = undefined;
    room.podiumState = undefined;
    room.playlist.currentRoundIndex = 0;

    for (const m of Object.values(room.members)) {
      m.score = 0;
      m.currentRoundScore = 0;
      m.hasVetoAvailable = true;
      m.status = m.role === 'SPECTATOR' ? 'CONNECTED' : 'NOT_READY';
    }

    // Reset stats
    const roomStats: Record<string, PlayerGameStats> = {};
    for (const m of Object.values(room.members)) {
      roomStats[m.id] = {
        memberId: m.id,
        roundScores: [],
        vetoTriggered: false,
        emojisSent: 0,
        soundsSent: 0,
        fourthPlaceCount: 0,
      };
    }
    this.stats.set(room.roomCode, roomStats);

    room.updatedAt = Date.now();
    this.broadcast(room.roomCode, 'room.state_changed', { state: 'LOBBY' });
    this.broadcast(room.roomCode, 'room.snapshot', { room });
  }

  // ── Social & Interaction ──────────────────────────────────────────────────

  public sendChat(codeOrId: string, memberId: string, text: string): void {
    const room = this.getRoom(codeOrId);
    if (!room) return;

    const member = room.members[memberId];
    if (!member) return;

    const cleaned = filterProfanity(
      (text || '')
        .replace(/<[^>]*>/g, '')
        .slice(0, 200)
        .trim(),
    );
    if (!cleaned) return;

    this.broadcast(room.roomCode, 'broadcast.chat', {
      memberId,
      displayName: member.displayName,
      text: cleaned,
      timestamp: Date.now(),
    });
  }

  public sendEmoji(codeOrId: string, memberId: string, emoji: string): void {
    const room = this.getRoom(codeOrId);
    if (!room) return;

    const member = room.members[memberId];
    if (!member) return;

    if (!this.rateLimiter.checkEmoji(memberId)) {
      this.sendToMember(room.roomCode, memberId, 'room.error', {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Max 3 emojis per second',
      });
      return;
    }

    const roomStats = this.stats.get(room.roomCode)?.[memberId];
    if (roomStats) roomStats.emojisSent++;

    this.broadcast(room.roomCode, 'broadcast.reaction', {
      memberId,
      displayName: member.displayName,
      emoji: emoji.slice(0, 8),
      timestamp: Date.now(),
    });
  }

  public sendSound(codeOrId: string, memberId: string, soundId: string): void {
    const room = this.getRoom(codeOrId);
    if (!room || !room.soundBitesEnabled) return;

    const member = room.members[memberId];
    if (!member) return;

    if (!this.rateLimiter.checkSound(memberId)) {
      const remainingMs = this.rateLimiter.getRemainingSoundCooldown(memberId);
      this.sendToMember(room.roomCode, memberId, 'room.error', {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Sound on cooldown. Try again in ${Math.ceil(remainingMs / 1000)}s`,
      });
      return;
    }

    const roomStats = this.stats.get(room.roomCode)?.[memberId];
    if (roomStats) roomStats.soundsSent++;

    this.broadcast(room.roomCode, 'broadcast.sound', {
      memberId,
      displayName: member.displayName,
      soundId: soundId.slice(0, 32),
      timestamp: Date.now(),
    });
  }

  // ── Sockets & Housekeeping ────────────────────────────────────────────────

  public registerSocket(roomCode: string, memberId: string, socket: WebSocketSender): void {
    let roomSockets = this.sockets.get(roomCode);
    if (!roomSockets) {
      roomSockets = new Map();
      this.sockets.set(roomCode, roomSockets);
    }
    roomSockets.set(memberId, socket);
  }

  public unregisterSocket(roomCode: string, memberId: string): void {
    const roomSockets = this.sockets.get(roomCode);
    if (roomSockets) {
      roomSockets.delete(memberId);
      if (roomSockets.size === 0) {
        this.sockets.delete(roomCode);
      }
    }
  }

  private cancelFsmTimer(roomCode: string): void {
    const timer = this.activeFsmTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer as unknown as NodeJS.Timeout);
      this.activeFsmTimers.delete(roomCode);
    }
  }

  private cleanupRoom(roomCode: string): void {
    this.cancelFsmTimer(roomCode);

    const hostTimer = this.hostMigrationTimers.get(roomCode);
    if (hostTimer) {
      clearTimeout(hostTimer);
      this.hostMigrationTimers.delete(roomCode);
    }

    for (const [key, timer] of this.disconnectGraceTimers.entries()) {
      if (key.startsWith(`${roomCode}:`)) {
        clearTimeout(timer);
        this.disconnectGraceTimers.delete(key);
      }
    }

    const roomSockets = this.sockets.get(roomCode);
    if (roomSockets) {
      for (const socket of roomSockets.values()) {
        try {
          socket.close(1000, 'Room closed');
        } catch {
          // ignore
        }
      }
    }

    const room = this.rooms.get(roomCode);
    if (room) {
      for (const mId of Object.keys(room.members)) {
        this.rateLimiter.cleanupMember(mId);
      }
      this.roomCodeById.delete(room.roomId);
      this.rooms.delete(roomCode);
    }

    this.sockets.delete(roomCode);
    this.seqCounters.delete(roomCode);
    this.stats.delete(roomCode);
  }

  public destroy(): void {
    for (const timer of this.disconnectGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectGraceTimers.clear();

    for (const timer of this.hostMigrationTimers.values()) {
      clearTimeout(timer);
    }
    this.hostMigrationTimers.clear();

    for (const timer of this.activeFsmTimers.values()) {
      clearTimeout(timer);
      clearInterval(timer as unknown as NodeJS.Timeout);
    }
    this.activeFsmTimers.clear();

    for (const roomSockets of this.sockets.values()) {
      for (const socket of roomSockets.values()) {
        try {
          socket.close(1000, 'Server shutting down');
        } catch {
          // ignore
        }
      }
    }

    this.rooms.clear();
    this.roomCodeById.clear();
    this.sockets.clear();
    this.seqCounters.clear();
    this.stats.clear();
    this.rateLimiter.reset();
  }
}
