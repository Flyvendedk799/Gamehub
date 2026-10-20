import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PartyActionBar } from '../src/components/party/lobby/PartyActionBar';
// Lobby components
import { PartyAvatarPicker } from '../src/components/party/lobby/PartyAvatarPicker';
import { PartyJoinCard } from '../src/components/party/lobby/PartyJoinCard';
import { PartyLobbyHeader } from '../src/components/party/lobby/PartyLobbyHeader';
import { PartyNameInput } from '../src/components/party/lobby/PartyNameInput';
import { PartyPlayerCard } from '../src/components/party/lobby/PartyPlayerCard';
import { SpectatorTray } from '../src/components/party/lobby/SpectatorTray';

import { GameVoteCard } from '../src/components/party/voting/GameVoteCard';
import { SynchronizedGameStartOverlay } from '../src/components/party/voting/SynchronizedGameStartOverlay';
import { VetoAlertBanner } from '../src/components/party/voting/VetoAlertBanner';
// Voting components
import { VotingCountdownTimer } from '../src/components/party/voting/VotingCountdownTimer';

import { FloatingEmojiDock } from '../src/components/party/hud/FloatingEmojiDock';
import { MiniLeaderboardTray } from '../src/components/party/hud/MiniLeaderboardTray';
// HUD components
import { PartyHeaderBar } from '../src/components/party/hud/PartyHeaderBar';
import { ReconnectToast } from '../src/components/party/hud/ReconnectToast';
import { SoundBiteBar } from '../src/components/party/hud/SoundBiteBar';

import { GrandPrixTable } from '../src/components/party/intermission/GrandPrixTable';
import { RoundOverStage } from '../src/components/party/intermission/RoundOverStage';
// Intermission components
import { StreakBadge } from '../src/components/party/intermission/StreakBadge';

// Podium components
import { PodiumStage } from '../src/components/party/podium/PodiumStage';
import { PostGameActionSuite } from '../src/components/party/podium/PostGameActionSuite';
import { SuperlativesShowcase } from '../src/components/party/podium/SuperlativesShowcase';

import type { PartyMember, PartyRoom } from '../src/lib/party/party-types';

const mockHost: PartyMember = {
  id: 'host-1',
  displayName: 'CaptainGrace',
  avatarId: 'pixel_fox',
  avatarColor: '#6366F1',
  role: 'HOST',
  status: 'READY',
  isHost: true,
  score: 42,
  currentRoundScore: 10,
  hasVetoAvailable: true,
  pingMs: 35,
  joinedAt: Date.now() - 60000,
};

const mockPlayer: PartyMember = {
  id: 'player-2',
  displayName: 'PixelSam',
  avatarId: 'neon_cat',
  avatarColor: '#10B981',
  role: 'PLAYER',
  status: 'NOT_READY',
  isHost: false,
  score: 28,
  currentRoundScore: 7,
  hasVetoAvailable: true,
  pingMs: 48,
  joinedAt: Date.now() - 50000,
  disconnectedAt: Date.now() - 15000,
};

const mockSpectator: PartyMember = {
  id: 'spec-3',
  displayName: 'WatcherDave',
  avatarId: 'chill_sloth',
  avatarColor: '#8B5CF6',
  role: 'SPECTATOR',
  status: 'READY',
  isHost: false,
  score: 0,
  currentRoundScore: 0,
  hasVetoAvailable: false,
  pingMs: 25,
  joinedAt: Date.now() - 40000,
};

const mockRoom: PartyRoom = {
  roomId: '11111111-1111-1111-1111-111111111111',
  roomCode: 'PARTY9',
  title: 'Arcade Night',
  isPrivate: false,
  maxActivePlayers: 8,
  allowSpectators: true,
  soundBitesEnabled: true,
  state: 'LOBBY',
  hostId: 'host-1',
  members: {
    'host-1': mockHost,
    'player-2': mockPlayer,
  },
  playlist: {
    mode: 'BEST_OF_5',
    totalRounds: 5,
    currentRoundIndex: 0,
    selectionStrategy: 'DEMOCRATIC_VOTE',
    intermissionDurationSec: 10,
  },
  createdAt: Date.now() - 120000,
  updatedAt: Date.now(),
};

describe('Party Mode Lobby Components', () => {
  it('renders PartyAvatarPicker with accessible radiogroups and touch targets >= 48px', () => {
    const html = renderToString(
      <PartyAvatarPicker
        selectedAvatarId="pixel_fox"
        selectedColor="#6366F1"
        onSelectAvatar={() => {}}
        onSelectColor={() => {}}
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Choose player avatar"');
    expect(html).toContain('aria-label="Choose accent color"');
    expect(html).toContain('min-w-[48px]');
    expect(html).toContain('min-h-[48px]');
    expect(html).toContain('aria-checked="true"');
  });

  it('renders PartyNameInput with character counter and error states', () => {
    const html = renderToString(
      <PartyNameInput value="CaptainGrace" onChange={() => {}} existingNames={['Alex']} />,
    );

    expect(html).toContain('value="CaptainGrace"');
    expect(html).toContain('12');
    expect(html).toContain('/20');
    expect(html).toContain('id="party-player-name"');
  });

  it('renders PartyJoinCard with 220x220 SVG QR code and direct share link', () => {
    const html = renderToString(<PartyJoinCard roomCode="PARTY9" baseUrl="https://gamehub.gg" />);

    expect(html).toContain('PARTY9');
    expect(html).toContain('width="220"');
    expect(html).toContain('height="220"');
    expect(html).toContain('Scannable QR code to join room');
    expect(html).toContain('Copy');
  });

  it('renders PartyLobbyHeader with high-contrast Base32 room code and host crown', () => {
    const html = renderToString(
      <PartyLobbyHeader
        roomCode="PARTY9"
        roomTitle="Arcade Night"
        isHost={true}
        hostName="CaptainGrace"
        playlistMode="BEST_OF_5"
        totalRounds={5}
      />,
    );

    expect(html).toContain('PARTY9');
    expect(html).toContain('Arcade Night');
    expect(html).toContain('CaptainGrace');
    expect(html).toContain('Best of 5');
  });

  it('renders PartyPlayerCard with READY glow, score, streak and host controls', () => {
    const html = renderToString(
      <PartyPlayerCard member={mockHost} isCurrentUser={true} canManage={true} onKick={() => {}} />,
    );

    expect(html).toContain('CaptainGrace');
    expect(html).toContain('READY');
    expect(html).toContain('👑 HOST');
    expect(html).toContain('42');
    expect(html).toContain('pts');
  });

  it('renders SpectatorTray with spectator count pill', () => {
    const html = renderToString(<SpectatorTray spectators={[mockSpectator]} />);

    expect(html).toContain('Spectator');
    expect(html).toContain('Watching party match');
  });

  it('renders PartyActionBar with ready toggle and host force start', () => {
    const html = renderToString(
      <PartyActionBar
        currentMember={mockHost}
        members={[mockHost, mockPlayer]}
        isHost={true}
        onToggleReady={() => {}}
        onStartMatch={() => {}}
        onLeaveRoom={() => {}}
      />,
    );

    expect(html).toContain('I&#x27;m Ready!');
    expect(html).toContain('Force Start Match');
    expect(html).toContain('Leave Party');
  });
});

describe('Party Mode Voting Components', () => {
  it('renders VotingCountdownTimer with SVG radial progress and ARIA timer role', () => {
    const html = renderToString(<VotingCountdownTimer remainingSec={12} totalSec={15} />);

    expect(html).toContain('role="img"');
    expect(html).toContain('Voting timer: 12 seconds remaining');
    expect(html).toContain('12');
  });

  it('renders GameVoteCard with candidate thumbnail, category, and voter badge stack', () => {
    const html = renderToString(
      <GameVoteCard
        option={{
          gameId: 'pixel-dash',
          title: 'Pixel Dash',
          thumbnailUrl: '/thumbnails/dash.png',
          category: 'Action',
          voteCount: 3,
          voterIds: ['host-1'],
        }}
        voters={[mockHost]}
        isSelected={true}
        onVote={() => {}}
      />,
    );

    expect(html).toContain('Pixel Dash');
    expect(html).toContain('Action');
    expect(html).toContain('3');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders VetoAlertBanner with glitch animation and announcer text', () => {
    const html = renderToString(
      <VetoAlertBanner initiatorName="CaptainGrace" vetoedGameTitle="Space Orbit" />,
    );

    expect(html).toContain('Tournament Veto Triggered!');
    expect(html).toContain('CaptainGrace');
    expect(html).toContain('Space Orbit');
    expect(html).toContain('role="alert"');
  });

  it('renders SynchronizedGameStartOverlay with 3-2-1 launch text', () => {
    const html = renderToString(
      <SynchronizedGameStartOverlay countdownValue={2} gameTitle="Pixel Dash" />,
    );

    expect(html).toContain('2');
    expect(html).toContain('Pixel Dash');
    expect(html).toContain('Launching Minigame');
  });
});

describe('Party Mode HUD Components', () => {
  it('renders PartyHeaderBar with round pips and latency pill', () => {
    const html = renderToString(
      <PartyHeaderBar
        roomCode="PARTY9"
        currentRound={1}
        totalRounds={5}
        pingMs={42}
        volume={0.8}
        isMuted={false}
        unreadChatCount={2}
        onVolumeChange={() => {}}
        onToggleMute={() => {}}
        onToggleChat={() => {}}
      />,
    );

    expect(html).toContain('PARTY9');
    expect(html).toContain('RND');
    expect(html).toContain('42ms');
    expect(html).toContain('title="Connection latency: 42ms"');
  });

  it('renders MiniLeaderboardTray with standings and score points', () => {
    const html = renderToString(
      <MiniLeaderboardTray members={[mockHost, mockPlayer]} currentMemberId="host-1" />,
    );

    expect(html).toContain('Standings');
    expect(html).toContain('CaptainGrace');
    expect(html).toContain('42');
    expect(html).toContain('PixelSam');
    expect(html).toContain('28');
  });

  it('renders FloatingEmojiDock with reactions', () => {
    const html = renderToString(
      <FloatingEmojiDock reactions={[]} comboBlastActive={false} onSendEmoji={() => true} />,
    );

    expect(html).toContain('🔥');
    expect(html).toContain('❤️');
    expect(html).toContain('GG');
  });

  it('renders SoundBiteBar with 6 sound buttons', () => {
    const html = renderToString(
      <SoundBiteBar canPlaySound={true} cooldownRemainingMs={0} onPlaySound={() => true} />,
    );

    expect(html).toContain('Airhorn');
    expect(html).toContain('Sad Trombone');
    expect(html).toContain('Cheer');
    expect(html).toContain('Drumroll');
    expect(html).toContain('Fanfare');
    expect(html).toContain('Bruh');
  });

  it('renders ReconnectToast with grace period countdown', () => {
    const html = renderToString(<ReconnectToast disconnectedMembers={[mockPlayer]} />);

    expect(html).toContain('PixelSam');
    expect(html).toContain('disconnected');
    expect(html).toContain('Grace period:');
    expect(html).toContain('role="alert"');
  });
});

describe('Party Mode Intermission & Podium Components', () => {
  it('renders StreakBadge for winning streaks >= 2', () => {
    const html = renderToString(<StreakBadge streakCount={3} />);

    expect(html).toContain('x Streak');
    expect(html).toContain('🔥');
  });

  it('renders GrandPrixTable with placement points and cumulative standings', () => {
    const html = renderToString(
      <GrandPrixTable members={[mockHost, mockPlayer]} currentMemberId="host-1" />,
    );

    expect(html).toContain('Grand Prix Standings');
    expect(html).toContain('CaptainGrace');
    expect(html).toContain('PixelSam');
  });

  it('renders RoundOverStage with intermission timer and host skip button', () => {
    const html = renderToString(
      <RoundOverStage
        room={mockRoom}
        members={[mockHost, mockPlayer]}
        currentMember={mockHost}
        isHost={true}
        onSkipIntermission={() => {}}
      />,
    );

    expect(html).toContain('Intermission Scoreboard');
    expect(html).toContain('Complete');
    expect(html).toContain('Skip Intermission (Host Override)');
  });

  it('renders PodiumStage with 3D pedestals for top winners', () => {
    const html = renderToString(
      <PodiumStage
        roomCode="PARTY9"
        roomTitle="Arcade Night"
        podiumState={{
          podiumPlacements: [
            {
              rank: 1,
              memberId: 'host-1',
              displayName: 'CaptainGrace',
              avatarId: 'pixel_fox',
              finalScore: 42,
            },
            {
              rank: 2,
              memberId: 'player-2',
              displayName: 'PixelSam',
              avatarId: 'neon_cat',
              finalScore: 28,
            },
          ],
          superlatives: [],
          rematchAvailable: true,
        }}
        isHost={true}
        onRematch={() => {}}
        onReturnToLobby={() => {}}
      />,
    );

    expect(html).toContain('Victory Podium');
    expect(html).toContain('CaptainGrace');
    expect(html).toContain('PixelSam');
  });

  it('renders SuperlativesShowcase with awards', () => {
    const html = renderToString(
      <SuperlativesShowcase
        awards={[
          {
            badgeId: 'SHARPSHOOTER',
            title: 'Sharpshooter',
            description: 'Highest accuracy and critical hits',
            recipientId: 'host-1',
            recipientName: 'CaptainGrace',
            avatarId: 'pixel_fox',
            statHighlight: '94% Accuracy',
          },
        ]}
      />,
    );

    expect(html).toContain('Match Superlatives');
    expect(html).toContain('Sharpshooter');
    expect(html).toContain('CaptainGrace');
    expect(html).toContain('94% Accuracy');
  });

  it('renders PostGameActionSuite with Rematch and Return to Lobby', () => {
    const html = renderToString(
      <PostGameActionSuite
        roomCode="PARTY9"
        roomTitle="Arcade Night"
        placements={[
          {
            rank: 1,
            memberId: 'host-1',
            displayName: 'CaptainGrace',
            avatarId: 'pixel_fox',
            finalScore: 42,
          },
        ]}
        isHost={true}
        onRematch={() => {}}
        onReturnToLobby={() => {}}
      />,
    );

    expect(html).toContain('Rematch (Same Party)');
    expect(html).toContain('Return to Lobby');
    expect(html).toContain('Share Results Card');
  });
});
