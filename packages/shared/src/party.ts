import { z } from 'zod';

/**
 * Party Mode Domain Models & Contracts (PRD Section 7)
 */

export const RoomState = z.enum([
  'LOBBY',
  'GAME_SELECT_VOTING',
  'COUNTDOWN',
  'IN_GAME',
  'ROUND_OVER',
  'PODIUM_CELEBRATION',
]);
export type RoomState = z.infer<typeof RoomState>;

export const PlayerRole = z.enum(['HOST', 'CO_HOST', 'PLAYER', 'SPECTATOR']);
export type PlayerRole = z.infer<typeof PlayerRole>;

export const PlayerStatus = z.enum(['CONNECTED', 'DISCONNECTED_GRACE', 'READY', 'NOT_READY']);
export type PlayerStatus = z.infer<typeof PlayerStatus>;

export const PartyMemberSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(20),
  avatarId: z.string(),
  avatarColor: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
  role: PlayerRole,
  status: PlayerStatus,
  isHost: z.boolean(),
  score: z.number().int().nonnegative(),
  currentRoundScore: z.number().int().nonnegative(),
  hasVetoAvailable: z.boolean(),
  pingMs: z.number().nonnegative(),
  joinedAt: z.number().int().positive(),
  disconnectedAt: z.number().int().positive().optional(),
});
export type PartyMember = z.infer<typeof PartyMemberSchema>;

export const PlaylistMode = z.enum(['SINGLE_GAME', 'BEST_OF_3', 'BEST_OF_5', 'POINTS_GAUNTLET']);
export type PlaylistMode = z.infer<typeof PlaylistMode>;

export const SelectionStrategy = z.enum(['DEMOCRATIC_VOTE', 'RANDOM_SHUFFLE', 'HOST_CURATED']);
export type SelectionStrategy = z.infer<typeof SelectionStrategy>;

export const PlaylistConfigSchema = z.object({
  mode: PlaylistMode,
  totalRounds: z.number().int().positive(),
  currentRoundIndex: z.number().int().nonnegative(),
  selectionStrategy: SelectionStrategy,
  curatedGameQueue: z.array(z.string()).optional(),
  intermissionDurationSec: z.number().int().positive().default(10),
});
export type PlaylistConfig = z.infer<typeof PlaylistConfigSchema>;

export const GameVoteOptionSchema = z.object({
  gameId: z.string().min(1),
  title: z.string().min(1),
  thumbnailUrl: z.string(),
  category: z.string().min(1),
  voteCount: z.number().int().nonnegative(),
  voterIds: z.array(z.string()),
});
export type GameVoteOption = z.infer<typeof GameVoteOptionSchema>;

export const GameVoteStateSchema = z.object({
  roundIndex: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  options: z.array(GameVoteOptionSchema),
  vetoTriggeredBy: z
    .object({
      memberId: z.string(),
      originalGameId: z.string(),
      vetoedGameId: z.string(),
    })
    .optional(),
});
export type GameVoteState = z.infer<typeof GameVoteStateSchema>;

export const SuperlativeBadgeId = z.enum([
  'SHARPSHOOTER',
  'CLUTCH_MASTER',
  'CHAOS_AGENT',
  'SPEED_DEMON',
  'PACIFIST',
  'UNLUCKY_LEGEND',
]);
export type SuperlativeBadgeId = z.infer<typeof SuperlativeBadgeId>;

export const SuperlativeAwardSchema = z.object({
  badgeId: SuperlativeBadgeId,
  title: z.string(),
  description: z.string(),
  recipientId: z.string(),
  recipientName: z.string(),
  avatarId: z.string(),
  statHighlight: z.string(),
});
export type SuperlativeAward = z.infer<typeof SuperlativeAwardSchema>;

export const PodiumPlacementSchema = z.object({
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  memberId: z.string(),
  displayName: z.string(),
  avatarId: z.string(),
  finalScore: z.number().int().nonnegative(),
});
export type PodiumPlacement = z.infer<typeof PodiumPlacementSchema>;

export const PodiumStateSchema = z.object({
  podiumPlacements: z.array(PodiumPlacementSchema),
  superlatives: z.array(SuperlativeAwardSchema),
  rematchAvailable: z.boolean(),
});
export type PodiumState = z.infer<typeof PodiumStateSchema>;

export const PartyRoomSchema = z.object({
  roomId: z.string().uuid(),
  roomCode: z.string().length(6),
  title: z.string().min(1),
  isPrivate: z.boolean(),
  maxActivePlayers: z.number().int().min(2).max(16).default(8),
  allowSpectators: z.boolean(),
  soundBitesEnabled: z.boolean(),
  state: RoomState,
  hostId: z.string(),
  members: z.record(PartyMemberSchema),
  activeMinigameId: z.string().optional(),
  playlist: PlaylistConfigSchema,
  votingState: GameVoteStateSchema.optional(),
  podiumState: PodiumStateSchema.optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});
export type PartyRoom = z.infer<typeof PartyRoomSchema>;

export const PartyRoomSummarySchema = z.object({
  roomId: z.string().uuid(),
  roomCode: z.string().length(6),
  title: z.string(),
  state: RoomState,
  memberCount: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive(),
  isPrivate: z.boolean(),
  allowSpectators: z.boolean(),
  playlistMode: PlaylistMode,
  createdAt: z.number().int().positive(),
});
export type PartyRoomSummary = z.infer<typeof PartyRoomSummarySchema>;

export const PartyOpCodeSchema = z.enum([
  // C2S
  'party.join',
  'party.leave',
  'party.ready',
  'party.vote',
  'party.veto',
  'party.emoji',
  'party.sound',
  'party.chat',
  'party.config_update',
  'party.start_match',
  'party.kick_player',
  'party.reconnect',
  // S2C
  'room.snapshot',
  'room.player_joined',
  'room.player_left',
  'room.player_updated',
  'room.state_changed',
  'voting.started',
  'voting.tick',
  'voting.resolved',
  'countdown.tick',
  'game.launch',
  'round.finished',
  'podium.announced',
  'broadcast.reaction',
  'broadcast.sound',
  'broadcast.chat',
  'room.host_migrated',
  'room.error',
]);
export type PartyOpCode = z.infer<typeof PartyOpCodeSchema>;

export interface PartySocketMessage<T = unknown> {
  op: PartyOpCode;
  seq: number;
  timestamp: number;
  roomId: string;
  payload: T;
}

export interface PartySessionClaims {
  roomId: string;
  roomCode: string;
  memberId: string;
  role: PlayerRole;
  issuedAt: number;
  nonce: string;
}

/** Base32 safe alphabet strictly excluding 0, O, 1, I, L */
export const PARTY_BASE32_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PARTY_CODE_LENGTH = 6;

/** Scoring constants: Grand Prix placement scoring */
export const GRAND_PRIX_POINTS = {
  1: 10,
  2: 7,
  3: 5,
  4: 3,
  5: 1,
  6: 1,
  7: 1,
  8: 1,
} as const;

/** Rate limits */
export const PARTY_RATE_LIMITS = {
  MAX_SOCKET_MSGS_PER_SEC: 20,
  MAX_EMOJIS_PER_SEC: 3,
  SOUND_COOLDOWN_MS: 4000,
  PING_INTERVAL_MS: 5000,
  PING_DROP_THRESHOLD_MS: 15000,
  DISCONNECT_GRACE_MS: 60000,
  HOST_MIGRATION_GRACE_MS: 15000,
} as const;

/** Curated candidate minigames */
export const DEFAULT_PARTY_MINIGAMES: Array<Omit<GameVoteOption, 'voteCount' | 'voterIds'>> = [
  {
    gameId: 'neon-racer',
    title: 'Neon Racer',
    thumbnailUrl: '/games/neon-racer.png',
    category: 'Racing',
  },
  {
    gameId: 'pixel-brawl',
    title: 'Pixel Brawl',
    thumbnailUrl: '/games/pixel-brawl.png',
    category: 'Action',
  },
  {
    gameId: 'astro-dodge',
    title: 'Astro Dodge',
    thumbnailUrl: '/games/astro-dodge.png',
    category: 'Arcade',
  },
  {
    gameId: 'gravity-golf',
    title: 'Gravity Golf',
    thumbnailUrl: '/games/gravity-golf.png',
    category: 'Sports',
  },
  {
    gameId: 'trivia-clash',
    title: 'Trivia Clash',
    thumbnailUrl: '/games/trivia-clash.png',
    category: 'Puzzle',
  },
  {
    gameId: 'bomb-tag',
    title: 'Bomb Tag',
    thumbnailUrl: '/games/bomb-tag.png',
    category: 'Chaos',
  },
];
