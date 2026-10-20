'use client';

import React from 'react';
import {
  type GameVoteOption,
  PARTY_AVATARS,
  type PartyMember,
} from '../../../lib/party/party-types';

export interface GameVoteCardProps {
  option: GameVoteOption;
  voters: PartyMember[];
  isSelected: boolean;
  isVetoed?: boolean;
  disabled?: boolean;
  onVote: (gameId: string) => void;
}

export function GameVoteCard({
  option,
  voters,
  isSelected,
  isVetoed = false,
  disabled = false,
  onVote,
}: GameVoteCardProps) {
  // Category color accents
  const categoryGradients: Record<string, string> = {
    Racing: 'from-amber-500/20 to-orange-500/10 border-amber-500/30',
    Action: 'from-rose-500/20 to-red-500/10 border-rose-500/30',
    Arcade: 'from-indigo-500/20 to-purple-500/10 border-indigo-500/30',
    Sports: 'from-emerald-500/20 to-teal-500/10 border-emerald-500/30',
    Puzzle: 'from-cyan-500/20 to-blue-500/10 border-cyan-500/30',
    Chaos: 'from-fuchsia-500/20 to-pink-500/10 border-fuchsia-500/30',
  };

  const gradientClass =
    categoryGradients[option.category] || 'from-neutral-800 to-neutral-900 border-neutral-700';

  return (
    <button
      type="button"
      onClick={() => onVote(option.gameId)}
      disabled={disabled || isVetoed}
      aria-pressed={isSelected}
      aria-label={`Vote for ${option.title}, category ${option.category}, current votes ${option.voteCount}`}
      className={`relative w-full flex flex-col rounded-2xl overflow-hidden border text-left transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-neutral-950 ${
        isVetoed
          ? 'border-rose-900/60 bg-neutral-950/80 opacity-60 cursor-not-allowed'
          : isSelected
            ? 'border-indigo-400 bg-indigo-950/40 ring-2 ring-indigo-500 shadow-xl shadow-indigo-500/20 scale-[1.02]'
            : 'border-neutral-800 bg-neutral-900/90 hover:border-neutral-700 hover:bg-neutral-800/80'
      }`}
    >
      {/* 16:9 Thumbnail Area */}
      <div
        className={`relative w-full aspect-video bg-gradient-to-br ${gradientClass} flex items-center justify-center overflow-hidden`}
      >
        {/* Placeholder / Visual illustration */}
        <div className="flex flex-col items-center justify-center p-4 text-center">
          <span className="text-4xl sm:text-5xl mb-2 filter drop-shadow">
            {option.category === 'Racing'
              ? '🏎️'
              : option.category === 'Action'
                ? '⚔️'
                : option.category === 'Arcade'
                  ? '🕹️'
                  : option.category === 'Sports'
                    ? '⛳'
                    : option.category === 'Puzzle'
                      ? '🧩'
                      : '💣'}
          </span>
          <span className="text-xs uppercase font-extrabold tracking-widest text-white/80">
            {option.category}
          </span>
        </div>

        {/* Vetoed Watermark */}
        {isVetoed && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
            <span className="px-3 py-1 bg-rose-600 text-white font-black text-sm uppercase tracking-wider rounded-lg transform -rotate-12 border border-rose-400 shadow-lg">
              🚫 VETOED
            </span>
          </div>
        )}

        {/* Selected Pill */}
        {isSelected && !isVetoed && (
          <div className="absolute top-2 right-2 bg-indigo-600 text-white text-[10px] uppercase font-black px-2 py-0.5 rounded-full shadow">
            Your Vote
          </div>
        )}

        {/* Vote Count Badge */}
        <div className="absolute bottom-2 right-2 px-2.5 py-1 rounded-xl bg-black/70 backdrop-blur-sm border border-white/10 text-white font-mono font-bold text-xs flex items-center gap-1 shadow">
          <span>🗳️</span> {option.voteCount}
        </div>
      </div>

      {/* Card Body */}
      <div className="p-4 flex flex-col justify-between flex-1 w-full">
        <div>
          <h3 className="text-base sm:text-lg font-bold text-white tracking-tight truncate">
            {option.title}
          </h3>
          <p className="text-xs text-neutral-400 mt-0.5">
            Category: <strong className="text-neutral-300">{option.category}</strong>
          </p>
        </div>

        {/* Voter Avatar Stack */}
        <div className="mt-4 pt-3 border-t border-neutral-800/80 flex items-center justify-between">
          <span className="text-[11px] font-medium text-neutral-400">Voters:</span>
          {voters.length > 0 ? (
            <div className="flex items-center -space-x-2 overflow-hidden">
              {voters.slice(0, 5).map((voter) => {
                const av = PARTY_AVATARS.find((a) => a.id === voter.avatarId);
                return (
                  <div
                    key={voter.id}
                    title={voter.displayName}
                    style={{ backgroundColor: voter.avatarColor }}
                    className="w-7 h-7 rounded-full border-2 border-neutral-900 flex items-center justify-center text-xs shadow"
                  >
                    <span>{av?.icon || '👤'}</span>
                  </div>
                );
              })}
              {voters.length > 5 && (
                <div className="w-7 h-7 rounded-full border-2 border-neutral-900 bg-neutral-800 text-neutral-300 font-mono text-[10px] font-bold flex items-center justify-center shadow">
                  +{voters.length - 5}
                </div>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-neutral-600 italic">No votes yet</span>
          )}
        </div>
      </div>
    </button>
  );
}
