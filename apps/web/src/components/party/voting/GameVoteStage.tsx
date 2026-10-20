'use client';

import React from 'react';
import type { GameVoteState, PartyMember } from '../../../lib/party/party-types';
import { GameVoteCard } from './GameVoteCard';
import { VetoActionButton } from './VetoActionButton';
import { VetoAlertBanner } from './VetoAlertBanner';
import { VotingCountdownTimer } from './VotingCountdownTimer';

export interface GameVoteStageProps {
  votingState: GameVoteState;
  remainingSec: number | null;
  members: PartyMember[];
  currentMember: PartyMember | null;
  onCastVote: (gameId: string) => void;
  onTriggerVeto: () => void;
}

export function GameVoteStage({
  votingState,
  remainingSec,
  members,
  currentMember,
  onCastVote,
  onTriggerVeto,
}: GameVoteStageProps) {
  const options = votingState.options || [];

  // Find user's current selected vote
  const userVoteGameId = options.find((opt) =>
    currentMember ? opt.voterIds.includes(currentMember.id) : false,
  )?.gameId;

  // Has veto been triggered?
  const vetoTrigger = votingState.vetoTriggeredBy;
  const vetoInitiator = vetoTrigger
    ? members.find((m) => m.id === vetoTrigger.memberId)?.displayName || 'A player'
    : null;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header & Radial Countdown Timer */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-6 bg-neutral-900/90 border border-neutral-800 rounded-2xl shadow-xl">
        <div className="text-center sm:text-left">
          <span className="text-xs font-mono uppercase tracking-widest text-indigo-400 font-semibold">
            Round Selection
          </span>
          <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight mt-1">
            Democratic Minigame Vote
          </h2>
          <p className="text-xs text-neutral-400 mt-1">
            Pick your favourite minigame. The highest vote wins!
          </p>
        </div>

        <VotingCountdownTimer remainingSec={remainingSec ?? 15} totalSec={15} />
      </div>

      {/* Veto Alert Banner if active */}
      {vetoTrigger && vetoInitiator && (
        <VetoAlertBanner initiatorName={vetoInitiator} vetoedGameTitle={vetoTrigger.vetoedGameId} />
      )}

      {/* 3 Minigame Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {options.map((opt) => {
          // Resolve member objects for voterIds
          const votersForOption = opt.voterIds
            .map((id) => members.find((m) => m.id === id))
            .filter((m): m is PartyMember => m !== undefined);

          const isVetoed = vetoTrigger?.vetoedGameId === opt.gameId;

          return (
            <GameVoteCard
              key={opt.gameId}
              option={opt}
              voters={votersForOption}
              isSelected={userVoteGameId === opt.gameId}
              isVetoed={isVetoed}
              onVote={onCastVote}
            />
          );
        })}
      </div>

      {/* Veto Trigger Action Area */}
      <div className="flex items-center justify-center pt-2">
        <VetoActionButton
          hasVetoAvailable={Boolean(currentMember?.hasVetoAvailable)}
          onTriggerVeto={onTriggerVeto}
          disabled={Boolean(vetoTrigger)}
        />
      </div>
    </div>
  );
}
