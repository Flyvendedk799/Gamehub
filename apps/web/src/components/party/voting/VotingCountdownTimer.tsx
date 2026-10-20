'use client';

import React from 'react';

export interface VotingCountdownTimerProps {
  remainingSec: number;
  totalSec?: number;
}

export function VotingCountdownTimer({ remainingSec, totalSec = 15 }: VotingCountdownTimerProps) {
  const safeRemaining = Math.max(0, Math.min(totalSec, remainingSec));
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const progress = safeRemaining / totalSec;
  const strokeDashoffset = circumference * (1 - progress);

  // Color morph: indigo (15-6s) -> amber (5-3s) -> crimson (2-0s)
  let strokeColor = '#6366f1'; // Indigo
  let textColor = 'text-indigo-400';
  let pulseEffect = '';

  if (safeRemaining <= 2) {
    strokeColor = '#ef4444'; // Crimson
    textColor = 'text-rose-500';
    pulseEffect = 'animate-ping';
  } else if (safeRemaining <= 5) {
    strokeColor = '#f59e0b'; // Amber
    textColor = 'text-amber-400';
  }

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative w-24 h-24 flex items-center justify-center">
        {safeRemaining <= 2 && (
          <div className={`absolute inset-0 rounded-full bg-rose-500/20 ${pulseEffect}`} />
        )}
        <svg
          className="w-full h-full transform -rotate-90"
          viewBox="0 0 80 80"
          role="img"
          aria-label={`Voting timer: ${safeRemaining} seconds remaining`}
        >
          {/* Background Track */}
          <circle
            cx="40"
            cy="40"
            r={radius}
            className="text-neutral-800"
            strokeWidth="6"
            stroke="currentColor"
            fill="transparent"
          />
          {/* Progress Ring */}
          <circle
            cx="40"
            cy="40"
            r={radius}
            strokeWidth="6"
            stroke={strokeColor}
            fill="transparent"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            className="transition-all duration-300 ease-linear"
          />
        </svg>

        {/* Center Text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span
            className={`text-2xl font-black font-mono tracking-tighter ${textColor}`}
            aria-live="polite"
          >
            {safeRemaining}
          </span>
          <span className="text-[9px] uppercase tracking-wider font-semibold text-neutral-400">
            sec
          </span>
        </div>
      </div>
    </div>
  );
}
