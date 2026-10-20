import {
  GRAND_PRIX_POINTS,
  type PartyMember,
  type PodiumPlacement,
  type SuperlativeAward,
} from '@playforge/shared';

const PROFANITY_LIST = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'cunt',
  'dick',
  'cock',
  'fag',
  'nigger',
  'bastard',
  'slut',
  'whore',
];

/**
 * Basic profanity filter: censors recognized offensive words with asterisks.
 */
export function filterProfanity(input: string): string {
  let cleaned = input;
  for (const word of PROFANITY_LIST) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '*'.repeat(word.length));
  }
  return cleaned;
}

/**
 * Sanitizes player display names:
 * - Strips script and style blocks
 * - Strips HTML tags
 * - Strips control characters
 * - Filters profanity
 * - Clamps length to 1-20 characters
 * - Fallbacks to 'Player' if empty
 * - Resolves naming collisions with existing names by appending " (2)", " (3)", etc.
 */
export function sanitizeDisplayName(rawName: string, existingNames: string[]): string {
  let cleaned = (rawName || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize control characters from display names
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim();

  cleaned = filterProfanity(cleaned);
  cleaned = cleaned.slice(0, 20).trim();

  if (!cleaned) {
    cleaned = 'Player';
  }

  if (!existingNames.includes(cleaned)) {
    return cleaned;
  }

  let counter = 2;
  while (true) {
    const suffix = ` (${counter})`;
    const maxBaseLen = 20 - suffix.length;
    const base = cleaned.slice(0, maxBaseLen).trim();
    const candidate = `${base}${suffix}`;
    if (!existingNames.includes(candidate)) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Calculates Grand Prix points based on round scores:
 * 1st = 10pt, 2nd = 7pt, 3rd = 5pt, 4th = 3pt, 5th-8th = 1pt.
 * Handles ties cleanly.
 */
export function calculateGrandPrixPoints(
  roundScores: Record<string, number>,
  eligibleMemberIds: string[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const id of eligibleMemberIds) {
    result[id] = 0;
  }

  // Sort eligible members by round score descending
  const sorted = [...eligibleMemberIds].sort((a, b) => {
    const scoreA = roundScores[a] ?? 0;
    const scoreB = roundScores[b] ?? 0;
    return scoreB - scoreA;
  });

  let currentRank = 1;
  for (let i = 0; i < sorted.length; i++) {
    const memberId = sorted[i];
    if (!memberId) continue;

    if (i > 0) {
      const prevId = sorted[i - 1];
      const prevScore = (prevId !== undefined ? roundScores[prevId] : undefined) ?? 0;
      const currScore = roundScores[memberId] ?? 0;
      if (currScore < prevScore) {
        currentRank = i + 1;
      }
    }

    const points =
      currentRank === 1
        ? GRAND_PRIX_POINTS[1]
        : currentRank === 2
          ? GRAND_PRIX_POINTS[2]
          : currentRank === 3
            ? GRAND_PRIX_POINTS[3]
            : currentRank === 4
              ? GRAND_PRIX_POINTS[4]
              : currentRank <= 8
                ? GRAND_PRIX_POINTS[5]
                : 0;

    result[memberId] = points;
  }

  return result;
}

export interface PlayerGameStats {
  memberId: string;
  roundScores: number[];
  vetoTriggered: boolean;
  emojisSent: number;
  soundsSent: number;
  fourthPlaceCount: number;
}

/**
 * Calculates top 3 podium placements and superlative awards.
 */
export function calculatePodium(
  members: Record<string, PartyMember>,
  stats: Record<string, PlayerGameStats>,
): {
  podiumPlacements: PodiumPlacement[];
  superlatives: SuperlativeAward[];
} {
  const activeMembers = Object.values(members).filter((m) => m.role !== 'SPECTATOR');

  // Sort by cumulative final score descending
  const sorted = [...activeMembers].sort((a, b) => b.score - a.score);

  const podiumPlacements: PodiumPlacement[] = [];
  const first = sorted[0];
  const second = sorted[1];
  const third = sorted[2];

  if (first) {
    podiumPlacements.push({
      rank: 1,
      memberId: first.id,
      displayName: first.displayName,
      avatarId: first.avatarId,
      finalScore: first.score,
    });
  }
  if (second) {
    podiumPlacements.push({
      rank: 2,
      memberId: second.id,
      displayName: second.displayName,
      avatarId: second.avatarId,
      finalScore: second.score,
    });
  }
  if (third) {
    podiumPlacements.push({
      rank: 3,
      memberId: third.id,
      displayName: third.displayName,
      avatarId: third.avatarId,
      finalScore: third.score,
    });
  }

  // Calculate 6 Superlatives
  const superlatives: SuperlativeAward[] = [];
  if (!first || activeMembers.length === 0) {
    return { podiumPlacements, superlatives };
  }

  // 1. SHARPSHOOTER — highest single-round score
  let sharpshooterMember: PartyMember = first;
  let maxSingleRoundScore = 0;
  for (const member of activeMembers) {
    const pStats = stats[member.id];
    const maxR = pStats?.roundScores?.length
      ? Math.max(...pStats.roundScores)
      : member.currentRoundScore;
    if (maxR >= maxSingleRoundScore) {
      maxSingleRoundScore = maxR;
      sharpshooterMember = member;
    }
  }
  superlatives.push({
    badgeId: 'SHARPSHOOTER',
    title: 'Sharpshooter',
    description: 'Highest single round score of the tournament',
    recipientId: sharpshooterMember.id,
    recipientName: sharpshooterMember.displayName,
    avatarId: sharpshooterMember.avatarId,
    statHighlight: `${maxSingleRoundScore} pts in one round`,
  });

  // 2. CLUTCH_MASTER — highest score in final round or dramatic surge
  let clutchMember: PartyMember = first;
  let maxFinalScore = -1;
  for (const member of activeMembers) {
    const pStats = stats[member.id];
    const finalScore = pStats?.roundScores?.length
      ? (pStats.roundScores[pStats.roundScores.length - 1] ?? member.currentRoundScore)
      : member.currentRoundScore;
    if (finalScore > maxFinalScore) {
      maxFinalScore = finalScore;
      clutchMember = member;
    }
  }
  superlatives.push({
    badgeId: 'CLUTCH_MASTER',
    title: 'Clutch Master',
    description: 'Delivered the strongest performance under final-round pressure',
    recipientId: clutchMember.id,
    recipientName: clutchMember.displayName,
    avatarId: clutchMember.avatarId,
    statHighlight: `${Math.max(0, maxFinalScore)} pts in the clutch`,
  });

  // 3. CHAOS_AGENT — triggered veto or highest emojis sent
  const vetoer = activeMembers.find((m) => stats[m.id]?.vetoTriggered);
  const mostEmojis = [...activeMembers].sort(
    (a, b) => (stats[b.id]?.emojisSent ?? 0) - (stats[a.id]?.emojisSent ?? 0),
  )[0];

  const chaosMember: PartyMember = vetoer ?? mostEmojis ?? first;
  const chaosHighlight = vetoer
    ? 'Triggered game veto'
    : `${stats[chaosMember.id]?.emojisSent ?? 0} reactions sent`;

  superlatives.push({
    badgeId: 'CHAOS_AGENT',
    title: 'Chaos Agent',
    description: 'Brought pure energy, wildcard votes, and maximum reactions',
    recipientId: chaosMember.id,
    recipientName: chaosMember.displayName,
    avatarId: chaosMember.avatarId,
    statHighlight: chaosHighlight,
  });

  // 4. SPEED_DEMON — lowest ping or fastest actions
  const speedMember: PartyMember =
    [...activeMembers].sort((a, b) => a.pingMs - b.pingMs)[0] ?? first;
  superlatives.push({
    badgeId: 'SPEED_DEMON',
    title: 'Speed Demon',
    description: 'Lightning-fast reflexes and seamless latency',
    recipientId: speedMember.id,
    recipientName: speedMember.displayName,
    avatarId: speedMember.avatarId,
    statHighlight: `${Math.round(speedMember.pingMs)}ms ping`,
  });

  // 5. PACIFIST — never used veto, consistent steady performance
  const pacifistMember: PartyMember =
    activeMembers.find((m) => m.hasVetoAvailable && m.id !== first.id) ??
    activeMembers.find((m) => m.hasVetoAvailable) ??
    sorted[sorted.length - 1] ??
    first;

  superlatives.push({
    badgeId: 'PACIFIST',
    title: 'Pacifist',
    description: 'Played with dignity, preserved their veto, and stayed cool',
    recipientId: pacifistMember.id,
    recipientName: pacifistMember.displayName,
    avatarId: pacifistMember.avatarId,
    statHighlight: 'Clean record & zero vetoes used',
  });

  // 6. UNLUCKY_LEGEND — runner-up / 4th place specialist or fighting spirit
  const fourthPlaceMember = [...activeMembers].sort(
    (a, b) => (stats[b.id]?.fourthPlaceCount ?? 0) - (stats[a.id]?.fourthPlaceCount ?? 0),
  )[0];

  const unluckyMember: PartyMember =
    fourthPlaceMember && (stats[fourthPlaceMember.id]?.fourthPlaceCount ?? 0) > 0
      ? fourthPlaceMember
      : (sorted[sorted.length - 1] ?? first);

  const fourthCount = stats[unluckyMember.id]?.fourthPlaceCount ?? 0;
  superlatives.push({
    badgeId: 'UNLUCKY_LEGEND',
    title: 'Unlucky Legend',
    description: 'Fought valiantly against the odds and won our hearts',
    recipientId: unluckyMember.id,
    recipientName: unluckyMember.displayName,
    avatarId: unluckyMember.avatarId,
    statHighlight:
      fourthCount > 0 ? `${fourthCount} near-miss podium finishes` : 'True sportsmanship award',
  });

  return { podiumPlacements, superlatives };
}
