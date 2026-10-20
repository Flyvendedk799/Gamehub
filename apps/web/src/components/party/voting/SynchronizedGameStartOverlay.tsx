'use client';

import React, { useEffect } from 'react';
import { partyAudio } from '../../../lib/party/PartyAudioBank';

export interface SynchronizedGameStartOverlayProps {
  countdownValue: number; // 3, 2, 1, 0
  gameTitle?: string;
}

export function SynchronizedGameStartOverlay({
  countdownValue,
  gameTitle = 'Next Minigame',
}: SynchronizedGameStartOverlayProps) {
  // Sound triggers on countdown changes
  useEffect(() => {
    if (countdownValue > 0) {
      partyAudio.playCountdownBeep(false);
    } else if (countdownValue === 0) {
      partyAudio.playCountdownBeep(true);
    }
  }, [countdownValue]);

  const isLaunch = countdownValue === 0;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 backdrop-blur-md select-none overflow-hidden"
    >
      <div className="text-center p-6 max-w-lg">
        <p className="text-sm uppercase tracking-widest font-mono text-indigo-400 mb-2">
          Launching Minigame
        </p>
        <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight mb-8">
          {gameTitle}
        </h2>

        {/* Big Animated Countdown Number */}
        <div className="relative flex items-center justify-center h-48 w-48 mx-auto">
          {isLaunch ? (
            <div className="flex flex-col items-center justify-center animate-bounce">
              <span className="text-6xl sm:text-7xl font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">
                GO!
              </span>
              <span className="text-xs uppercase tracking-widest text-emerald-400 font-mono mt-2 font-bold">
                Match Started!
              </span>
            </div>
          ) : (
            <div
              key={countdownValue}
              className="text-8xl sm:text-9xl font-black font-mono text-white tracking-tight animate-ping"
              style={{ animationDuration: '1s', animationIterationCount: '1' }}
            >
              {countdownValue}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
