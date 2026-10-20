'use client';

import React from 'react';
import { SOUND_BITES, type SoundBiteId } from '../../../lib/party/party-types';

export interface SoundBiteBarProps {
  canPlaySound: boolean;
  cooldownRemainingMs: number;
  onPlaySound: (id: SoundBiteId) => boolean;
}

export function SoundBiteBar({
  canPlaySound,
  cooldownRemainingMs,
  onPlaySound,
}: SoundBiteBarProps) {
  const cooldownFraction = Math.max(0, Math.min(1, cooldownRemainingMs / 4000));

  return (
    <div className="fixed bottom-3 left-3 sm:left-6 z-30 flex flex-col gap-1.5 p-2 bg-neutral-950/85 backdrop-blur-md border border-neutral-800 rounded-2xl shadow-2xl max-w-sm">
      {/* 4s Cooldown Bar Indicator */}
      {!canPlaySound && (
        <div className="w-full bg-neutral-800 h-1.5 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-500 transition-all duration-100 ease-linear"
            style={{ width: `${cooldownFraction * 100}%` }}
          />
        </div>
      )}

      {/* 6 Sound Bites */}
      <div className="flex items-center gap-1.5">
        {SOUND_BITES.map((sound) => (
          <button
            key={sound.id}
            type="button"
            disabled={!canPlaySound}
            onClick={() => onPlaySound(sound.id)}
            title={sound.label}
            className={`w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center text-xl transition-all border ${
              canPlaySound
                ? 'bg-neutral-900/80 hover:bg-neutral-800 text-white hover:scale-105 active:scale-95 border-neutral-700/60 shadow'
                : 'bg-neutral-900/40 text-neutral-600 border-neutral-800 cursor-not-allowed opacity-50'
            } focus:outline-none focus:ring-2 focus:ring-indigo-500`}
            aria-label={`Play ${sound.label} sound effect`}
          >
            <span>{sound.icon}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
