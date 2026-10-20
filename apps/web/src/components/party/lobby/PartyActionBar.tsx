'use client';

import React from 'react';
import type { PartyMember } from '../../../lib/party/party-types';

export interface PartyActionBarProps {
  currentMember: PartyMember | null;
  members: PartyMember[];
  isHost: boolean;
  onToggleReady: (ready: boolean) => void;
  onStartMatch: () => void;
  onLeaveRoom: () => void;
}

export function PartyActionBar({
  currentMember,
  members,
  isHost,
  onToggleReady,
  onStartMatch,
  onLeaveRoom,
}: PartyActionBarProps) {
  const isReady = currentMember?.status === 'READY';
  const isSpectator = currentMember?.role === 'SPECTATOR';
  const activePlayers = members.filter((m) => m.role !== 'SPECTATOR');
  const allReady = activePlayers.length >= 2 && activePlayers.every((m) => m.status === 'READY');
  const canStart = isHost && activePlayers.length >= 2;

  return (
    <div className="sticky bottom-0 left-0 right-0 z-30 w-full bg-neutral-950/90 backdrop-blur-md border-t border-neutral-800 p-3 sm:p-4 min-h-[56px]">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* Leave Room CTA */}
        <button
          type="button"
          onClick={onLeaveRoom}
          className="px-4 py-2.5 rounded-xl bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-800 text-xs sm:text-sm font-semibold transition-colors flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-neutral-600 min-h-[48px]"
          aria-label="Leave Party Room"
        >
          <span>🚪</span> Leave Party
        </button>

        {/* Central Ready / Start actions */}
        <div className="flex items-center gap-3">
          {/* Player Ready Toggle (if not spectator) */}
          {!isSpectator && (
            <button
              type="button"
              onClick={() => onToggleReady(!isReady)}
              className={`px-6 py-2.5 rounded-xl font-bold text-sm sm:text-base transition-all shadow-md min-h-[48px] flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-neutral-950 ${
                isReady
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white ring-2 ring-emerald-400'
                  : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
              }`}
              aria-label={isReady ? 'Mark as Not Ready' : 'Mark as Ready'}
            >
              <span>{isReady ? '✓' : '⏳'}</span>
              <span>{isReady ? "I'm Ready!" : 'Ready Up'}</span>
            </button>
          )}

          {/* Host Start Match CTA */}
          {isHost && (
            <button
              type="button"
              onClick={onStartMatch}
              disabled={!canStart}
              className={`px-6 py-2.5 rounded-xl font-extrabold text-sm sm:text-base transition-all shadow-lg min-h-[48px] flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-neutral-950 ${
                allReady
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-neutral-950 shadow-emerald-500/30 animate-pulse'
                  : canStart
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/20'
                    : 'bg-neutral-800 text-neutral-500 cursor-not-allowed border border-neutral-700/60'
              }`}
              aria-label="Start Party Match"
            >
              <span>🚀</span>
              <span>
                {allReady
                  ? 'All Ready — Launch!'
                  : activePlayers.length < 2
                    ? 'Need 2+ Players'
                    : 'Force Start Match'}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
