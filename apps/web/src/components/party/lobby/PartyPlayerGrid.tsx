'use client';

import React from 'react';
import type { PartyMember } from '../../../lib/party/party-types';
import { PartyPlayerCard } from './PartyPlayerCard';

export interface PartyPlayerGridProps {
  members: PartyMember[];
  currentMemberId: string | null;
  isHost: boolean;
  maxPlayers?: number;
  onKickPlayer?: (memberId: string) => void;
}

export function PartyPlayerGrid({
  members,
  currentMemberId,
  isHost,
  maxPlayers = 8,
  onKickPlayer,
}: PartyPlayerGridProps) {
  const activePlayers = members.filter((m) => m.role !== 'SPECTATOR');
  const emptySlotsCount = Math.max(0, maxPlayers - activePlayers.length);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-xs sm:text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Party Players ({activePlayers.length}/{maxPlayers})
        </h2>
        <span className="text-xs text-neutral-500 font-mono">
          {activePlayers.filter((p) => p.status === 'READY').length}/{activePlayers.length} Ready
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {activePlayers.map((player) => (
          <PartyPlayerCard
            key={player.id}
            member={player}
            isCurrentUser={player.id === currentMemberId}
            canManage={isHost}
            onKick={onKickPlayer}
          />
        ))}

        {/* Empty player slot placeholders */}
        {Array.from({ length: Math.min(emptySlotsCount, 4) }).map((_, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder slot indices
            key={`empty-slot-${idx}`}
            className="flex flex-col items-center justify-center p-6 rounded-2xl border-2 border-dashed border-neutral-800/80 bg-neutral-900/30 text-neutral-600 min-h-[180px]"
          >
            <div className="w-12 h-12 rounded-full border border-dashed border-neutral-800 flex items-center justify-center text-xl mb-2">
              +
            </div>
            <span className="text-xs font-medium tracking-tight">Waiting for player...</span>
          </div>
        ))}
      </div>
    </div>
  );
}
