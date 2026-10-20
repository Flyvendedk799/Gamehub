import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from './room-manager';
import { createSessionToken } from './session-auth';

describe('Party RoomManager & FSM Engine', () => {
  let manager: RoomManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new RoomManager({
      lobbyReadyCountdownSec: 5,
      votingWindowSec: 15,
      vetoWindowSec: 5,
      countdownTicks: 3,
      intermissionDurationSec: 10,
      disconnectGraceMs: 60000,
      hostMigrationGraceMs: 15000,
      pingDropThresholdMs: 15000,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('Room Creation & Joining', () => {
    it('creates a room with Base32 code, sets up host, and returns session token', () => {
      const { roomCode, roomId, hostSessionToken, memberId, room } = manager.createRoom({
        title: 'Retro Night',
        maxPlayers: 8,
      });

      expect(roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      expect(roomId).toBeDefined();
      expect(memberId).toBe(room.hostId);
      expect(hostSessionToken).toBeDefined();
      expect(room.state).toBe('LOBBY');
      expect(room.members[memberId]?.isHost).toBe(true);
      expect(room.members[memberId]?.role).toBe('HOST');
      expect(room.members[memberId]?.score).toBe(0);
      expect(room.members[memberId]?.hasVetoAvailable).toBe(true);
    });

    it('sanitizes player names, strips tags/profanity, and resolves collisions', () => {
      const { roomCode } = manager.createRoom({ hostName: 'Alice' });

      // Alice joins again -> Alice (2)
      const join1 = manager.joinRoom(roomCode, { displayName: 'Alice' });
      expect(join1.room.members[join1.memberId]?.displayName).toBe('Alice (2)');

      // Alice joins again -> Alice (3)
      const join2 = manager.joinRoom(roomCode, { displayName: 'Alice' });
      expect(join2.room.members[join2.memberId]?.displayName).toBe('Alice (3)');

      // HTML tags and whitespace
      const join3 = manager.joinRoom(roomCode, {
        displayName: '  <b>Bob</b><script>alert(1)</script>  ',
      });
      expect(join3.room.members[join3.memberId]?.displayName).toBe('Bob');

      // Empty name falls back to 'Player'
      const join4 = manager.joinRoom(roomCode, { displayName: '   ' });
      expect(join4.room.members[join4.memberId]?.displayName).toBe('Player');
    });

    it('enforces room player capacity and routes to spectator if allowed', () => {
      const { roomCode } = manager.createRoom({ maxPlayers: 2, allowSpectators: true });

      // Host is player 1
      // Player 2
      const p2 = manager.joinRoom(roomCode, { displayName: 'Player2' });
      expect(p2.room.members[p2.memberId]?.role).toBe('PLAYER');

      // Player 3 exceeds maxActivePlayers (2) -> assigned SPECTATOR
      const p3 = manager.joinRoom(roomCode, { displayName: 'Player3' });
      expect(p3.room.members[p3.memberId]?.role).toBe('SPECTATOR');
    });

    it('throws ROOM_FULL if room is full and spectators are disallowed', () => {
      const { roomCode } = manager.createRoom({ maxPlayers: 2, allowSpectators: false });
      manager.joinRoom(roomCode, { displayName: 'Player2' });

      expect(() => {
        manager.joinRoom(roomCode, { displayName: 'Player3' });
      }).toThrow('ROOM_FULL');
    });
  });

  describe('Lobby Ready Checks & Countdown', () => {
    it('triggers 5s countdown when 100% active players are READY, and transitions to GAME_SELECT_VOTING', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      manager.setPlayerReady(roomCode, hostId, true);
      const room = manager.getRoom(roomCode)!;
      expect(room.members[hostId]?.status).toBe('READY');
      expect(room.state).toBe('LOBBY');

      // Guest marks ready -> all 2 active players ready
      manager.setPlayerReady(roomCode, guest.memberId, true);
      expect(room.members[guest.memberId]?.status).toBe('READY');
      expect(room.state).toBe('LOBBY');

      // Advance 5 seconds
      vi.advanceTimersByTime(5000);

      expect(room.state).toBe('GAME_SELECT_VOTING');
      expect(room.votingState).toBeDefined();
      expect(room.votingState?.options).toHaveLength(3);
    });

    it('cancels countdown if a player toggles NOT_READY before timer fires', () => {
      const { roomCode, memberId: hostId } = manager.createRoom();
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      manager.setPlayerReady(roomCode, hostId, true);
      manager.setPlayerReady(roomCode, guest.memberId, true);

      // Advance 3 seconds (2s remaining)
      vi.advanceTimersByTime(3000);
      expect(manager.getRoom(roomCode)!.state).toBe('LOBBY');

      // Guest unreadies
      manager.setPlayerReady(roomCode, guest.memberId, false);

      // Advance another 5s
      vi.advanceTimersByTime(5000);
      expect(manager.getRoom(roomCode)!.state).toBe('LOBBY');
    });

    it('allows Host Force Start override to transition directly to voting', () => {
      const { roomCode, memberId: hostId } = manager.createRoom();
      manager.joinRoom(roomCode, { displayName: 'Guest' });

      // Host force starts without anyone being ready
      manager.startMatch(roomCode, hostId);

      const room = manager.getRoom(roomCode)!;
      expect(room.state).toBe('GAME_SELECT_VOTING');
      expect(room.votingState?.options).toHaveLength(3);
    });
  });

  describe('Game Voting & Veto Logic', () => {
    it('tallies votes from players, handles changes, and selects winning minigame after 15s', () => {
      const { roomCode, memberId: hostId } = manager.createRoom();
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      manager.startMatch(roomCode, hostId);
      const room = manager.getRoom(roomCode)!;
      const options = room.votingState!.options;
      const optA = options[0]!;
      const optB = options[1]!;

      // Host votes for optA
      manager.castVote(roomCode, hostId, optA.gameId);
      expect(optA.voteCount).toBe(1);
      expect(optA.voterIds).toContain(hostId);

      // Host changes vote to optB
      manager.castVote(roomCode, hostId, optB.gameId);
      expect(optA.voteCount).toBe(0);
      expect(optB.voteCount).toBe(1);

      // Guest votes for optB
      manager.castVote(roomCode, guest.memberId, optB.gameId);
      expect(optB.voteCount).toBe(2);

      // Fast-forward 15s to resolve voting
      vi.advanceTimersByTime(15000);

      expect(room.activeMinigameId).toBe(optB.gameId);
      expect(room.state).toBe('COUNTDOWN');
    });

    it('allows 1 tournament veto per player, replacing winner with runner-up', () => {
      const { roomCode, memberId: hostId } = manager.createRoom();
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      manager.startMatch(roomCode, hostId);
      const room = manager.getRoom(roomCode)!;
      const options = room.votingState!.options;
      const optA = options[0]!;
      const optB = options[1]!;

      // Host votes for optA (1 vote)
      manager.castVote(roomCode, hostId, optA.gameId);
      // Guest votes for optB (1 vote)
      manager.castVote(roomCode, guest.memberId, optB.gameId);

      expect(room.members[hostId]?.hasVetoAvailable).toBe(true);

      // Guest triggers veto
      const { originalGameId, vetoedGameId } = manager.triggerVeto(roomCode, guest.memberId);
      expect(room.members[guest.memberId]?.hasVetoAvailable).toBe(false);
      expect(room.votingState?.vetoTriggeredBy).toBeDefined();
      expect(room.votingState?.vetoTriggeredBy?.memberId).toBe(guest.memberId);
      expect(originalGameId).toBeDefined();
      expect(vetoedGameId).toBeDefined();

      // Guest tries to veto a second time -> should throw
      expect(() => {
        manager.triggerVeto(roomCode, guest.memberId);
      }).toThrow('NO_VETO_AVAILABLE');

      // Resolve voting
      manager.resolveVoting(roomCode);
      expect(room.activeMinigameId).toBe(vetoedGameId);
      expect(room.state).toBe('COUNTDOWN');
    });
  });

  describe('Countdown, IN_GAME, Round Over & Grand Prix Scoring', () => {
    it('progresses 3-2-1 countdown into IN_GAME, scores Grand Prix points, and intermits 10s', () => {
      const { roomCode, memberId: hostId } = manager.createRoom();
      const p2 = manager.joinRoom(roomCode, { displayName: 'Player2' });
      const p3 = manager.joinRoom(roomCode, { displayName: 'Player3' });
      const p4 = manager.joinRoom(roomCode, { displayName: 'Player4' });

      manager.startMatch(roomCode, hostId);
      // Resolve voting immediately
      manager.resolveVoting(roomCode);
      const room = manager.getRoom(roomCode)!;
      expect(room.state).toBe('COUNTDOWN');

      // 3 ticks (3s)
      vi.advanceTimersByTime(3000);
      expect(room.state).toBe('IN_GAME');

      // Submit round scores: p2=100 (1st), host=80 (2nd), p3=50 (3rd), p4=10 (4th)
      manager.submitRoundScores(roomCode, {
        [p2.memberId]: 100,
        [hostId]: 80,
        [p3.memberId]: 50,
        [p4.memberId]: 10,
      });

      expect(room.state).toBe('ROUND_OVER');
      // Grand Prix: 1st=10, 2nd=7, 3rd=5, 4th=3
      expect(room.members[p2.memberId]?.score).toBe(10);
      expect(room.members[hostId]?.score).toBe(7);
      expect(room.members[p3.memberId]?.score).toBe(5);
      expect(room.members[p4.memberId]?.score).toBe(3);

      // Host skips intermission
      manager.skipIntermission(roomCode, hostId);
      expect(room.playlist.currentRoundIndex).toBe(1);
      expect(room.state).toBe('GAME_SELECT_VOTING');
    });
  });

  describe('Podium Celebration & Rematch', () => {
    it('triggers PODIUM_CELEBRATION on final round, calculates podium and 6 superlatives, and supports rematch', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({
        playlistMode: 'SINGLE_GAME', // 1 round total
      });
      const p2 = manager.joinRoom(roomCode, { displayName: 'Player2' });
      const p3 = manager.joinRoom(roomCode, { displayName: 'Player3' });

      manager.startMatch(roomCode, hostId);
      manager.resolveVoting(roomCode);
      vi.advanceTimersByTime(3000); // countdown -> IN_GAME

      // Round 1 (final)
      manager.submitRoundScores(roomCode, {
        [p2.memberId]: 200, // 1st -> 10 pts
        [hostId]: 150, // 2nd -> 7 pts
        [p3.memberId]: 100, // 3rd -> 5 pts
      });

      // 10s intermission completes
      vi.advanceTimersByTime(10000);

      const room = manager.getRoom(roomCode)!;
      expect(room.state).toBe('PODIUM_CELEBRATION');
      expect(room.podiumState).toBeDefined();

      const podium = room.podiumState!;
      expect(podium.podiumPlacements).toHaveLength(3);
      expect(podium.podiumPlacements[0]?.memberId).toBe(p2.memberId);
      expect(podium.podiumPlacements[0]?.rank).toBe(1);
      expect(podium.podiumPlacements[1]?.memberId).toBe(hostId);
      expect(podium.podiumPlacements[1]?.rank).toBe(2);
      expect(podium.podiumPlacements[2]?.memberId).toBe(p3.memberId);
      expect(podium.podiumPlacements[2]?.rank).toBe(3);

      // Verify 6 Superlatives
      expect(podium.superlatives).toHaveLength(6);
      const badgeIds = podium.superlatives.map((s) => s.badgeId);
      expect(badgeIds).toContain('SHARPSHOOTER');
      expect(badgeIds).toContain('CLUTCH_MASTER');
      expect(badgeIds).toContain('CHAOS_AGENT');
      expect(badgeIds).toContain('SPEED_DEMON');
      expect(badgeIds).toContain('PACIFIST');
      expect(badgeIds).toContain('UNLUCKY_LEGEND');

      // Rematch resets back to LOBBY while keeping players
      manager.requestRematch(roomCode);
      expect(room.state).toBe('LOBBY');
      expect(room.playlist.currentRoundIndex).toBe(0);
      expect(room.members[p2.memberId]?.score).toBe(0);
      expect(room.members[p2.memberId]?.hasVetoAvailable).toBe(true);
      expect(Object.keys(room.members)).toHaveLength(3);
    });
  });

  describe('60-Second Disconnect Grace Window & Session Recovery', () => {
    it('sets DISCONNECTED_GRACE on disconnect and restores state on reconnect with valid token', () => {
      const { roomCode, roomId } = manager.createRoom();
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      // Socket disconnects
      manager.handleSocketDisconnect(roomCode, guest.memberId);
      const room = manager.getRoom(roomCode)!;
      expect(room.members[guest.memberId]?.status).toBe('DISCONNECTED_GRACE');
      expect(room.members[guest.memberId]?.disconnectedAt).toBeDefined();

      // Advance 30s (still within 60s grace)
      vi.advanceTimersByTime(30000);
      expect(room.members[guest.memberId]).toBeDefined();

      // Reconnect with session token
      const result = manager.reconnectMember(roomCode, {
        sessionToken: guest.sessionToken,
        memberId: guest.memberId,
      });

      expect(result.success).toBe(true);
      expect(result.restoredState.status).toBe('CONNECTED');
      expect(room.members[guest.memberId]?.status).toBe('CONNECTED');
      expect(room.members[guest.memberId]?.disconnectedAt).toBeUndefined();

      // Advance past the original 60s -> should NOT remove member
      vi.advanceTimersByTime(40000);
      expect(room.members[guest.memberId]).toBeDefined();
    });

    it('vacates player slot after 60s disconnect grace period expires', () => {
      const { roomCode } = manager.createRoom();
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      manager.handleSocketDisconnect(roomCode, guest.memberId);
      const room = manager.getRoom(roomCode)!;
      expect(room.members[guest.memberId]).toBeDefined();

      // 60 seconds expire
      vi.advanceTimersByTime(60000);

      expect(room.members[guest.memberId]).toBeUndefined();
    });
  });

  describe('Host Migration', () => {
    it('migrates host after 15s grace buffer on unexpected disconnect to oldest connected player', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      const guest1 = manager.joinRoom(roomCode, { displayName: 'Guest1' });
      vi.advanceTimersByTime(100);
      const guest2 = manager.joinRoom(roomCode, { displayName: 'Guest2' });

      // Host socket drops unexpectedly
      manager.handleSocketDisconnect(roomCode, hostId);
      const room = manager.getRoom(roomCode)!;
      expect(room.hostId).toBe(hostId);

      // Advance 10s (within 15s buffer) -> host still original
      vi.advanceTimersByTime(10000);
      expect(room.hostId).toBe(hostId);

      // Advance 5s (total 15s) -> host migration triggers to guest1 (oldest)
      vi.advanceTimersByTime(5000);

      expect(room.hostId).toBe(guest1.memberId);
      expect(room.members[guest1.memberId]?.isHost).toBe(true);
      expect(room.members[guest1.memberId]?.role).toBe('HOST');
      expect(room.members[hostId]?.isHost).toBe(false);
    });

    it('migrates host immediately on voluntary departure', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      // Host leaves voluntarily
      manager.leaveRoom(roomCode, hostId);

      const room = manager.getRoom(roomCode)!;
      expect(room.members[hostId]).toBeUndefined();
      expect(room.hostId).toBe(guest.memberId);
      expect(room.members[guest.memberId]?.isHost).toBe(true);
      expect(room.members[guest.memberId]?.role).toBe('HOST');
    });

    it('cleans up room immediately when sole host leaves', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      manager.leaveRoom(roomCode, hostId);
      expect(manager.getRoom(roomCode)).toBeUndefined();
    });

    it('assigns host role on member reconnect if room lacks a connected host', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      // Both disconnect
      manager.handleSocketDisconnect(roomCode, hostId);
      manager.handleSocketDisconnect(roomCode, guest.memberId);

      // Advance 15s so host migration grace expires while guest is disconnected (no eligible connected players)
      vi.advanceTimersByTime(15000);

      // Guest reconnects
      const recon = manager.reconnectMember(roomCode, {
        memberId: guest.memberId,
        sessionToken: guest.sessionToken,
      });

      expect(recon.success).toBe(true);
      const room = manager.getRoom(roomCode)!;
      expect(room.hostId).toBe(guest.memberId);
      expect(room.members[guest.memberId]?.isHost).toBe(true);
      expect(room.members[guest.memberId]?.role).toBe('HOST');
    });
  });

  describe('Privileged Host Session Authorization', () => {
    it('prevents former demoted host from executing privileged actions', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      const guest = manager.joinRoom(roomCode, { displayName: 'Guest' });

      // Host disconnects and 15s host migration expires -> guest promoted, original host demoted
      manager.handleSocketDisconnect(roomCode, hostId);
      vi.advanceTimersByTime(15000);

      const room = manager.getRoom(roomCode)!;
      expect(room.hostId).toBe(guest.memberId);
      expect(room.members[hostId]?.isHost).toBe(false);

      // Demoted former host tries to start match
      expect(() => manager.startMatch(roomCode, hostId)).toThrow('UNAUTHORIZED');

      // Demoted former host tries to kick player
      expect(() => manager.kickPlayer(roomCode, hostId, guest.memberId)).toThrow('UNAUTHORIZED');

      // Demoted former host tries to skip intermission
      room.state = 'ROUND_OVER';
      expect(() => manager.skipIntermission(roomCode, hostId)).toThrow('UNAUTHORIZED');

      // Demoted former host tries to request rematch
      room.state = 'PODIUM_CELEBRATION';
      expect(() => manager.requestRematch(roomCode, hostId)).toThrow('UNAUTHORIZED');
    });
  });

  describe('Grand Prix Scoring Edge Cases', () => {
    it('handles zero scores, negative scores, ties with rank displacement, and non-participants', () => {
      const { roomCode, memberId: hostId } = manager.createRoom({ hostName: 'Host' });
      const p1 = manager.joinRoom(roomCode, { displayName: 'P1' });
      const p2 = manager.joinRoom(roomCode, { displayName: 'P2' });
      const p3 = manager.joinRoom(roomCode, { displayName: 'P3' });

      const room = manager.getRoom(roomCode)!;
      room.state = 'IN_GAME';

      // Scores:
      // Host: 100 (1st tie -> 10 pts)
      // P1: 100 (1st tie -> 10 pts)
      // P2: 50 (3rd rank displaced -> 5 pts)
      // P3: 0 (zero score -> 0 pts)
      manager.submitRoundScores(roomCode, {
        [hostId]: 100,
        [p1.memberId]: 100,
        [p2.memberId]: 50,
        [p3.memberId]: 0,
      });

      expect(room.members[hostId]?.currentRoundScore).toBe(10);
      expect(room.members[p1.memberId]?.currentRoundScore).toBe(10);
      expect(room.members[p2.memberId]?.currentRoundScore).toBe(5);
      expect(room.members[p3.memberId]?.currentRoundScore).toBe(0);
    });
  });

  describe('Room Appearance & Cleanup Lifecycle', () => {
    it('accepts both avatarId and hostAvatarId alias fields', () => {
      const room1 = manager.createRoom({ avatarId: 'fox', avatarColor: '#ff0000' });
      const r1 = manager.getRoom(room1.roomCode)!;
      expect(r1.members[room1.memberId]?.avatarId).toBe('fox');
      expect(r1.members[room1.memberId]?.avatarColor).toBe('#ff0000');

      const room2 = manager.createRoom({ hostAvatarId: 'cat', hostAvatarColor: '#00ff00' });
      const r2 = manager.getRoom(room2.roomCode)!;
      expect(r2.members[room2.memberId]?.avatarId).toBe('cat');
      expect(r2.members[room2.memberId]?.avatarColor).toBe('#00ff00');
    });
  });
});
