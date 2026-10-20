'use client';

import React from 'react';

export interface StreakBadgeProps {
  streakCount: number;
}

export function StreakBadge({ streakCount }: StreakBadgeProps) {
  if (streakCount < 2) return null;

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-rose-500/20 border border-orange-500/40 text-amber-300 shadow-md shadow-orange-500/10 animate-pulse select-none"
      title={`${streakCount} consecutive round wins!`}
    >
      <span className="text-xs">🔥</span>
      <span>{streakCount}x Streak</span>
    </span>
  );
}
