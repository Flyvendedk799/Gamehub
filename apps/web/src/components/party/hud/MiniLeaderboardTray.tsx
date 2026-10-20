'use client';

import React, { useState } from 'react';
import { PARTY_AVATARS, type PartyMember } from '../../../lib/party/party-types';

export interface MiniLeaderboardTrayProps {
  members: PartyMember[];
  currentMemberId: string | null;
}

export function MiniLeaderboardTray({ members, currentMemberId }: MiniLeaderboardTrayProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Sort by score descending
  const sortedPlayers = [...members]
    .filter((m) => m.role !== 'SPECTATOR')
    .sort((a, b) => b.score - a.score);

  return (
    <aside
      aria-label="Live Standings"
      className="absolute top-14 left-3 z-20 max-w-[220px] w-full bg-neutral-950/85 backdrop-blur-md border border-neutral-800 rounded-2xl p-3 shadow-xl select-none"
    >
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between text-left text-xs font-bold uppercase tracking-wider text-neutral-300 hover:text-white transition-colors focus:outline-none"
        aria-expanded={isExpanded}
      >
        <span className="flex items-center gap-1.5">
          <span>🏆</span> Standings
        </span>
        <span className="text-[10px] text-neutral-500 font-mono">{isExpanded ? '▲' : '▼'}</span>
      </button>

      {isExpanded && (
        <ol className="mt-2.5 space-y-1.5 max-h-48 overflow-y-auto pr-1">
          {sortedPlayers.map((player, index) => {
            const isSelf = player.id === currentMemberId;
            const rank = index + 1;
            const av = PARTY_AVATARS.find((a) => a.id === player.avatarId) || {
              icon: '🎮',
            };

            let rankBadge = `${rank}`;
            if (rank === 1) rankBadge = '🥇';
            if (rank === 2) rankBadge = '🥈';
            if (rank === 3) rankBadge = '🥉';

            return (
              <li
                key={player.id}
                className={`flex items-center justify-between px-2 py-1 rounded-xl text-xs transition-colors ${
                  isSelf
                    ? 'bg-indigo-500/20 text-white font-bold border border-indigo-500/30'
                    : 'text-neutral-300 hover:bg-neutral-900'
                }`}
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span className="w-5 text-center font-mono font-bold text-xs shrink-0">
                    {rankBadge}
                  </span>
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-xs shrink-0"
                    style={{ backgroundColor: player.avatarColor }}
                  >
                    {av.icon}
                  </span>
                  <span className="truncate max-w-[85px]">{player.displayName}</span>
                </div>
                <div className="flex items-center gap-1 font-mono text-xs font-bold text-neutral-200">
                  <span>{player.score}</span>
                  {player.currentRoundScore > 0 && (
                    <span className="text-[10px] text-emerald-400 font-bold animate-pulse">
                      +{player.currentRoundScore}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
