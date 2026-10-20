'use client';

import React from 'react';
import { GRAND_PRIX_POINTS, PARTY_AVATARS, type PartyMember } from '../../../lib/party/party-types';
import { StreakBadge } from './StreakBadge';

export interface GrandPrixTableProps {
  members: PartyMember[];
  currentMemberId: string | null;
}

export function GrandPrixTable({ members, currentMemberId }: GrandPrixTableProps) {
  // Sort players by total score descending
  const sortedPlayers = [...members]
    .filter((m) => m.role !== 'SPECTATOR')
    .sort((a, b) => b.score - a.score);

  return (
    <div className="w-full bg-neutral-900/90 border border-neutral-800 rounded-2xl p-4 sm:p-6 shadow-xl">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-neutral-800">
        <div>
          <h3 className="text-base sm:text-lg font-black text-white uppercase tracking-wider flex items-center gap-2">
            <span>🏁</span> Grand Prix Standings
          </h3>
          <p className="text-xs text-neutral-400 mt-0.5">
            1st: +10 • 2nd: +7 • 3rd: +5 • 4th: +3 • 5th+: +1
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs sm:text-sm">
          <thead>
            <tr className="text-neutral-500 font-mono text-[10px] uppercase tracking-wider border-b border-neutral-800">
              <th className="pb-2 pl-2">Rank</th>
              <th className="pb-2">Player</th>
              <th className="pb-2 text-center">Round Pts</th>
              <th className="pb-2 text-right pr-2">Total Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {sortedPlayers.map((player, index) => {
              const rank = index + 1;
              const isSelf = player.id === currentMemberId;
              const av = PARTY_AVATARS.find((a) => a.id === player.avatarId) || {
                icon: '🎮',
              };

              // Simulated streak count for players with high scores
              const streak = player.currentRoundScore >= 10 ? 2 : 0;

              // Placement reward for rank
              const gpPoints = GRAND_PRIX_POINTS[rank as keyof typeof GRAND_PRIX_POINTS] || 0;

              return (
                <tr
                  key={player.id}
                  className={`transition-colors ${
                    isSelf
                      ? 'bg-indigo-500/10 font-semibold text-white'
                      : 'text-neutral-200 hover:bg-neutral-800/40'
                  }`}
                >
                  <td className="py-3 pl-2 font-mono font-bold">
                    <span className="flex items-center gap-1.5">
                      {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`}
                    </span>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0 shadow"
                        style={{ backgroundColor: player.avatarColor }}
                      >
                        {av.icon}
                      </div>
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="truncate max-w-[130px] sm:max-w-xs">
                          {player.displayName}
                        </span>
                        {isSelf && (
                          <span className="text-[9px] uppercase px-1 py-0.2 bg-indigo-500/30 text-indigo-300 rounded font-bold">
                            YOU
                          </span>
                        )}
                        <StreakBadge streakCount={streak} />
                      </div>
                    </div>
                  </td>
                  <td className="py-3 text-center font-mono">
                    {player.currentRoundScore > 0 ? (
                      <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                        +{gpPoints} pts
                      </span>
                    ) : (
                      <span className="text-neutral-500">—</span>
                    )}
                  </td>
                  <td className="py-3 text-right pr-2 font-mono font-bold text-white text-sm sm:text-base">
                    {player.score}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
