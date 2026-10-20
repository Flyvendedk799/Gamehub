import type {
  GameVoteOption,
  PartyMember,
  PartyOpCode,
  PartyRoom,
  PartyRoomSummary,
  PartySocketMessage,
  PlayerRole,
  PlayerStatus,
  PlaylistConfig,
  PlaylistMode,
  RoomState,
  SelectionStrategy,
} from '@playforge/shared';

export type {
  GameVoteOption,
  PartyMember,
  PartyOpCode,
  PartyRoom,
  PartyRoomSummary,
  PartySocketMessage,
  PlayerRole,
  PlayerStatus,
  PlaylistConfig,
  PlaylistMode,
  RoomState,
  SelectionStrategy,
};

export interface CreatePartyRoomInput {
  title?: string;
  isPrivate?: boolean;
  maxPlayers?: number;
  playlistMode?: PlaylistMode;
  allowSpectators?: boolean;
  soundBitesEnabled?: boolean;
  selectionStrategy?: SelectionStrategy;
  totalRounds?: number;
  hostName?: string;
  hostAvatarId?: string;
  hostAvatarColor?: string;
}

export interface JoinPartyRoomInput {
  displayName: string;
  avatarId?: string;
  avatarColor?: string;
  rolePreference?: 'PLAYER' | 'SPECTATOR';
}

export interface ReconnectPartyRoomInput {
  sessionToken: string;
  memberId: string;
}

export interface RoomTimerOptions {
  lobbyReadyCountdownSec?: number;
  votingWindowSec?: number;
  vetoWindowSec?: number;
  countdownTicks?: number;
  intermissionDurationSec?: number;
  disconnectGraceMs?: number;
  hostMigrationGraceMs?: number;
  pingDropThresholdMs?: number;
}
