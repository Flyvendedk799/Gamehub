'use client';

import React, { useEffect, useState } from 'react';
import type { PartyMember, PartyRoom } from '../../../lib/party/party-types';
import { GrandPrixTable } from './GrandPrixTable';

export interface RoundOverStageProps {
  room: PartyRoom;
  members: PartyMember[];
  currentMember: PartyMember | null;
  isHost: boolean;
  onSkipIntermission: () => void;
}

export function RoundOverStage({
  room,
  members,
  currentMember,
  isHost,
  onSkipIntermission,
}: RoundOverStageProps) {
  const [countdown, setCountdown] = useState(room.playlist.intermissionDurationSec || 10);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Determine top round scorer
  const roundWinner = [...members].sort((a, b) => b.currentRoundScore - a.currentRoundScore)[0];

  const roundNum = room.playlist.currentRoundIndex + 1;
  const totalRounds = room.playlist.totalRounds;

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Banner */}
      <div className="text-center p-6 bg-gradient-to-b from-neutral-900 to-neutral-950 border border-neutral-800 rounded-3xl shadow-2xl relative overflow-hidden">
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-indigo-400">
          Round {roundNum} of {totalRounds} Complete
        </span>

        <h2 className="text-3xl sm:text-4xl font-black text-white tracking-tight mt-1 mb-2">
          Intermission Scoreboard
        </h2>

        {roundWinner && roundWinner.currentRoundScore > 0 && (
          <p className="text-sm text-neutral-300 flex items-center justify-center gap-1.5 font-medium">
            <span>🏆</span> Round Winner:{' '}
            <strong className="text-white font-bold">{roundWinner.displayName}</strong>
          </p>
        )}

        {/* 10s Countdown Bar */}
        <div className="mt-6 flex flex-col items-center">
          <div className="flex items-center gap-2 mb-2 font-mono text-xs text-neutral-400">
            <span>Next Round starting in</span>
            <span className="text-base font-bold text-amber-400 px-2 py-0.5 bg-neutral-900 rounded border border-neutral-800">
              {countdown}s
            </span>
          </div>
          <div className="w-full max-w-md h-2 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-amber-500 transition-all duration-1000 ease-linear"
              style={{
                width: `${(countdown / (room.playlist.intermissionDurationSec || 10)) * 100}%`,
              }}
            />
          </div>
        </div>

        {/* Host Skip Intermission Override */}
        {isHost && (
          <div className="mt-6">
            <button
              type="button"
              onClick={onSkipIntermission}
              className="px-5 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white font-bold text-xs sm:text-sm tracking-wide border border-neutral-700 transition-colors shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-label="Skip intermission and advance now"
            >
              ⏩ Skip Intermission (Host Override)
            </button>
          </div>
        )}
      </div>

      {/* Standings Table */}
      <GrandPrixTable members={members} currentMemberId={currentMember?.id ?? null} />
    </div>
  );
}
