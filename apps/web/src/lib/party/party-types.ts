import {
  DEFAULT_PARTY_MINIGAMES,
  GRAND_PRIX_POINTS,
  type GameVoteOption,
  type GameVoteState,
  PARTY_BASE32_ALPHABET,
  PARTY_CODE_LENGTH,
  PARTY_RATE_LIMITS,
  type PartyMember,
  type PartyOpCode,
  type PartyRoom,
  type PartyRoomSummary,
  type PartySocketMessage,
  type PlayerRole,
  type PlayerStatus,
  type PlaylistConfig,
  type PlaylistMode,
  type PodiumPlacement,
  type PodiumState,
  type RoomState,
  type SelectionStrategy,
  type SuperlativeAward,
  type SuperlativeBadgeId,
} from '@playforge/shared/party';

export {
  DEFAULT_PARTY_MINIGAMES,
  GRAND_PRIX_POINTS,
  PARTY_BASE32_ALPHABET,
  PARTY_CODE_LENGTH,
  PARTY_RATE_LIMITS,
  type GameVoteOption,
  type GameVoteState,
  type PartyMember,
  type PartyOpCode,
  type PartyRoom,
  type PartyRoomSummary,
  type PartySocketMessage,
  type PlayerRole,
  type PlayerStatus,
  type PlaylistConfig,
  type PlaylistMode,
  type PodiumPlacement,
  type PodiumState,
  type RoomState,
  type SelectionStrategy,
  type SuperlativeAward,
  type SuperlativeBadgeId,
};

export interface PartySession {
  roomId: string;
  roomCode: string;
  memberId: string;
  sessionToken: string;
  isHost: boolean;
}

export interface PartyUserProfile {
  displayName: string;
  avatarId: string;
  avatarColor: string;
}

export type SoundBiteId = 'airhorn' | 'sad_trombone' | 'cheer' | 'drumroll' | 'fanfare' | 'bruh';

export interface SoundBiteConfig {
  id: SoundBiteId;
  label: string;
  icon: string;
}

export const SOUND_BITES: SoundBiteConfig[] = [
  { id: 'airhorn', label: 'Airhorn', icon: '📢' },
  { id: 'sad_trombone', label: 'Sad Trombone', icon: '🎺' },
  { id: 'cheer', label: 'Cheer', icon: '👏' },
  { id: 'drumroll', label: 'Drumroll', icon: '🥁' },
  { id: 'fanfare', label: 'Fanfare', icon: '👑' },
  { id: 'bruh', label: 'Bruh', icon: '🗿' },
];

export const PARTY_EMOJIS = ['❤️', '🔥', '😂', '🎉', '💀', '💩', 'GG'] as const;
export type PartyEmoji = (typeof PARTY_EMOJIS)[number];

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  avatarId: string;
  avatarColor: string;
  text: string;
  timestamp: number;
}

export interface FloatingReaction {
  id: string;
  emoji: string;
  senderId: string;
  senderName: string;
  gutter: 'left' | 'right';
  xPercent: number; // 0-15 or 85-100
  createdAt: number;
}

// 24 Vector Avatar definitions (PRD / UI Spec)
export interface AvatarDefinition {
  id: string;
  label: string;
  icon: string;
}

export const PARTY_AVATARS: AvatarDefinition[] = [
  { id: 'fox', label: 'Fox', icon: '🦊' },
  { id: 'cat', label: 'Cat', icon: '🐱' },
  { id: 'dog', label: 'Dog', icon: '🐶' },
  { id: 'lion', label: 'Lion', icon: '🦁' },
  { id: 'bear', label: 'Bear', icon: '🐻' },
  { id: 'panda', label: 'Panda', icon: '🐼' },
  { id: 'koala', label: 'Koala', icon: '🐨' },
  { id: 'tiger', label: 'Tiger', icon: '🐯' },
  { id: 'rabbit', label: 'Rabbit', icon: '🐰' },
  { id: 'dragon', label: 'Dragon', icon: '🐲' },
  { id: 'unicorn', label: 'Unicorn', icon: '🦄' },
  { id: 'owl', label: 'Owl', icon: '🦉' },
  { id: 'frog', label: 'Frog', icon: '🐸' },
  { id: 'octopus', label: 'Octopus', icon: '🐙' },
  { id: 'monkey', label: 'Monkey', icon: '🐵' },
  { id: 'penguin', label: 'Penguin', icon: '🐧' },
  { id: 'alien', label: 'Alien', icon: '👾' },
  { id: 'robot', label: 'Robot', icon: '🤖' },
  { id: 'wizard', label: 'Wizard', icon: '🧙' },
  { id: 'ninja', label: 'Ninja', icon: '🥷' },
  { id: 'ghost', label: 'Ghost', icon: '👻' },
  { id: 'skull', label: 'Skull', icon: '💀' },
  { id: 'superhero', label: 'Hero', icon: '🦸' },
  { id: 'star', label: 'Star', icon: '⭐' },
];

export const PARTY_ACCENT_COLORS = [
  '#6366f1', // Indigo
  '#10b981', // Emerald
  '#f43f5e', // Rose
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#ec4899', // Pink
  '#64748b', // Slate
] as const;

/**
 * Uppercase normalization auto-mapping confusing characters:
 * 0 -> Q, O -> Q, 1 -> J, I -> J, L -> J
 * Strips any characters not in the safe Base32 alphabet.
 * Clamps to max 6 characters.
 */
export function normalizeRoomCode(input: string): string {
  if (!input) return '';
  const mapped = input.toUpperCase().replace(/[0O]/g, 'Q').replace(/[1IL]/g, 'J');

  let sanitized = '';
  for (const char of mapped) {
    if (PARTY_BASE32_ALPHABET.includes(char)) {
      sanitized += char;
    }
    if (sanitized.length >= PARTY_CODE_LENGTH) break;
  }

  return sanitized;
}

const PROFANITY_LIST = [
  'fuck',
  'shit',
  'ass',
  'bitch',
  'cunt',
  'dick',
  'nigger',
  'faggot',
  'whore',
  'slut',
  'bastard',
  'cock',
  'pussy',
];

export function sanitizeDisplayName(name: string): {
  cleanName: string;
  hasProfanity: boolean;
} {
  const trimmed = name.trim().slice(0, 20);
  let hasProfanity = false;
  let cleanName = trimmed;

  for (const badWord of PROFANITY_LIST) {
    const regex = new RegExp(`\\b${badWord}\\b`, 'gi');
    if (regex.test(cleanName)) {
      hasProfanity = true;
      cleanName = cleanName.replace(regex, '***');
    }
  }

  return { cleanName, hasProfanity };
}

// ── Session & Profile Storage ──────────────────────────────────────────────

const SESSION_PREFIX = 'pf_party_session:';
const PROFILE_KEY = 'pf_party_profile';

function sessionKey(code: string): string {
  return `${SESSION_PREFIX}${normalizeRoomCode(code)}`;
}

export function savePartySession(session: PartySession): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(sessionKey(session.roomCode), JSON.stringify(session));
    // also set in sessionStorage for current tab
    sessionStorage.setItem(sessionKey(session.roomCode), JSON.stringify(session));
  } catch {
    // Quota or incognito
  }
}

export function getPartySession(roomCode: string): PartySession | null {
  if (typeof window === 'undefined') return null;
  const key = sessionKey(roomCode);
  try {
    const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PartySession>;
    if (
      typeof parsed.roomCode === 'string' &&
      typeof parsed.memberId === 'string' &&
      typeof parsed.sessionToken === 'string'
    ) {
      return {
        roomId: parsed.roomId ?? '',
        roomCode: parsed.roomCode,
        memberId: parsed.memberId,
        sessionToken: parsed.sessionToken,
        isHost: Boolean(parsed.isHost),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPartySession(roomCode: string): void {
  if (typeof window === 'undefined') return;
  const key = sessionKey(roomCode);
  try {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function savePartyProfile(profile: PartyUserProfile): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // ignore
  }
}

export function getPartyProfile(): PartyUserProfile {
  const fallback: PartyUserProfile = {
    displayName: 'Player',
    avatarId: PARTY_AVATARS[0]?.id ?? 'fox',
    avatarColor: PARTY_ACCENT_COLORS[0],
  };

  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PartyUserProfile>;
    return {
      displayName: parsed.displayName?.trim() || fallback.displayName,
      avatarId: parsed.avatarId || fallback.avatarId,
      avatarColor: parsed.avatarColor || fallback.avatarColor,
    };
  } catch {
    return fallback;
  }
}
