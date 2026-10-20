'use client';

import React, { useEffect, useState } from 'react';
import { partyAudio } from '../../../lib/party/PartyAudioBank';
import { PARTY_AVATARS, type PodiumState } from '../../../lib/party/party-types';
import { ConfettiCannon } from './ConfettiCannon';
import { PostGameActionSuite } from './PostGameActionSuite';
import { SuperlativesShowcase } from './SuperlativesShowcase';

export interface PodiumStageProps {
  roomCode: string;
  roomTitle: string;
  podiumState: PodiumState;
  isHost: boolean;
  onRematch: () => void;
  onReturnToLobby: () => void;
}

export function PodiumStage({
  roomCode,
  roomTitle,
  podiumState,
  isHost,
  onRematch,
  onReturnToLobby,
}: PodiumStageProps) {
  const [hasRisen, setHasRisen] = useState(false);

  useEffect(() => {
    // Play fanfare on podium arrival
    partyAudio.playSoundBite('fanfare', true);
    const timer = setTimeout(() => {
      setHasRisen(true);
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const first = podiumState.podiumPlacements.find((p) => p.rank === 1);
  const second = podiumState.podiumPlacements.find((p) => p.rank === 2);
  const third = podiumState.podiumPlacements.find((p) => p.rank === 3);

  const getAvatarIcon = (avatarId: string) =>
    PARTY_AVATARS.find((a) => a.id === avatarId)?.icon || '🎮';

  return (
    <div className="relative w-full max-w-5xl mx-auto px-4 py-8 space-y-10 select-none">
      {/* Confetti Explosion */}
      <ConfettiCannon />

      {/* Header */}
      <div className="text-center space-y-2">
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-amber-400">
          Tournament Complete
        </span>
        <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
          Victory Podium
        </h1>
        <p className="text-xs sm:text-sm text-neutral-400">
          All rounds concluded. All hail the champions of {roomTitle}!
        </p>
      </div>

      {/* 3D Tiered Pedestals Stage */}
      <div className="relative flex items-end justify-center gap-3 sm:gap-6 pt-12 pb-4 px-2 min-h-[380px]">
        {/* 2nd Place Silver Pedestal (Height 160px) */}
        {second && (
          <div
            className={`flex flex-col items-center transition-all duration-700 ease-out ${
              hasRisen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-24'
            }`}
            style={{ transitionDelay: '300ms' }}
          >
            {/* Player Info Above Pedestal */}
            <div className="flex flex-col items-center mb-3">
              <span className="text-2xl mb-1 filter drop-shadow">🥈</span>
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-slate-700/80 border-2 border-slate-300 flex items-center justify-center text-3xl shadow-lg">
                {getAvatarIcon(second.avatarId)}
              </div>
              <span className="font-extrabold text-sm sm:text-base text-white mt-1.5 truncate max-w-[110px]">
                {second.displayName}
              </span>
              <span className="font-mono text-xs text-slate-300 font-bold">
                {second.finalScore} pts
              </span>
            </div>

            {/* 160px Pedestal Pillar */}
            <div className="w-24 sm:w-32 h-[160px] rounded-t-2xl bg-gradient-to-b from-slate-400 to-slate-700 border-t-2 border-x-2 border-slate-300 shadow-2xl flex flex-col items-center justify-between p-3 text-neutral-900 font-black">
              <span className="text-lg uppercase tracking-wider font-mono">2nd</span>
              <span className="text-xs font-mono font-bold text-slate-200">SILVER</span>
            </div>
          </div>
        )}

        {/* 1st Place Gold Champion Pedestal (Height 220px) */}
        {first && (
          <div
            className={`flex flex-col items-center transition-all duration-700 ease-out z-10 ${
              hasRisen ? 'opacity-100 translate-y-0 scale-105' : 'opacity-0 translate-y-28 scale-95'
            }`}
            style={{ transitionDelay: '600ms' }}
          >
            {/* Crown & Avatar */}
            <div className="flex flex-col items-center mb-3">
              <span className="text-4xl mb-1 filter drop-shadow animate-bounce">👑</span>
              <div className="w-18 h-18 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-amber-400 to-yellow-600 border-4 border-amber-300 flex items-center justify-center text-4xl shadow-2xl ring-4 ring-amber-500/30">
                {getAvatarIcon(first.avatarId)}
              </div>
              <span className="font-black text-base sm:text-lg text-amber-300 mt-2 truncate max-w-[140px] drop-shadow">
                {first.displayName}
              </span>
              <span className="font-mono text-sm font-black text-white px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 mt-0.5">
                {first.finalScore} pts
              </span>
            </div>

            {/* 220px Pedestal Pillar */}
            <div className="w-28 sm:w-36 h-[220px] rounded-t-2xl bg-gradient-to-b from-amber-400 via-yellow-500 to-amber-700 border-t-4 border-x-4 border-yellow-200 shadow-2xl shadow-amber-500/40 flex flex-col items-center justify-between p-4 text-neutral-950 font-black">
              <span className="text-2xl uppercase tracking-wider font-mono">1st</span>
              <span className="text-xs font-mono font-black text-yellow-100 tracking-widest">
                CHAMPION
              </span>
            </div>
          </div>
        )}

        {/* 3rd Place Bronze Pedestal (Height 110px) */}
        {third && (
          <div
            className={`flex flex-col items-center transition-all duration-700 ease-out ${
              hasRisen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-20'
            }`}
            style={{ transitionDelay: '100ms' }}
          >
            {/* Player Info Above Pedestal */}
            <div className="flex flex-col items-center mb-3">
              <span className="text-2xl mb-1 filter drop-shadow">🥉</span>
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-amber-950/80 border-2 border-amber-700 flex items-center justify-center text-3xl shadow-lg">
                {getAvatarIcon(third.avatarId)}
              </div>
              <span className="font-extrabold text-sm sm:text-base text-white mt-1.5 truncate max-w-[110px]">
                {third.displayName}
              </span>
              <span className="font-mono text-xs text-amber-400 font-bold">
                {third.finalScore} pts
              </span>
            </div>

            {/* 110px Pedestal Pillar */}
            <div className="w-24 sm:w-32 h-[110px] rounded-t-2xl bg-gradient-to-b from-amber-700 to-amber-950 border-t-2 border-x-2 border-amber-600 shadow-2xl flex flex-col items-center justify-between p-3 text-neutral-200 font-black">
              <span className="text-lg uppercase tracking-wider font-mono">3rd</span>
              <span className="text-xs font-mono font-bold text-amber-400">BRONZE</span>
            </div>
          </div>
        )}
      </div>

      {/* Superlatives Showcase */}
      <SuperlativesShowcase awards={podiumState.superlatives} />

      {/* Post-Game Action Suite */}
      <PostGameActionSuite
        roomCode={roomCode}
        roomTitle={roomTitle}
        placements={podiumState.podiumPlacements}
        isHost={isHost}
        onRematch={onRematch}
        onReturnToLobby={onReturnToLobby}
      />
    </div>
  );
}
