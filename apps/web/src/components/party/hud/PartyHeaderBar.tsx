'use client';

import React from 'react';

export interface PartyHeaderBarProps {
  roomCode: string;
  currentRound: number;
  totalRounds: number;
  pingMs: number;
  volume: number;
  isMuted: boolean;
  unreadChatCount?: number;
  onVolumeChange: (vol: number) => void;
  onToggleMute: () => void;
  onToggleChat?: () => void;
}

export function PartyHeaderBar({
  roomCode,
  currentRound,
  totalRounds,
  pingMs,
  volume,
  isMuted,
  unreadChatCount = 0,
  onVolumeChange,
  onToggleMute,
  onToggleChat,
}: PartyHeaderBarProps) {
  // Latency pill styling
  let pingBadgeClass = 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
  let pingDotClass = 'bg-emerald-400';
  if (pingMs > 120) {
    pingBadgeClass = 'bg-rose-500/20 text-rose-400 border-rose-500/30';
    pingDotClass = 'bg-rose-400';
  } else if (pingMs >= 50) {
    pingBadgeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
    pingDotClass = 'bg-amber-400';
  }

  return (
    <header className="w-full bg-neutral-950/80 backdrop-blur-md border-b border-neutral-800/80 px-3 sm:px-6 py-2.5 flex items-center justify-between gap-3 text-white select-none z-30">
      {/* Left: Room Code & Round Pips */}
      <div className="flex items-center gap-3 sm:gap-4">
        <div className="flex items-center gap-1.5 font-mono">
          <span className="text-[10px] uppercase font-bold text-neutral-400">ROOM</span>
          <span className="text-sm sm:text-base font-black tracking-wider text-white bg-neutral-900 border border-neutral-700 px-2 py-0.5 rounded-lg">
            {roomCode}
          </span>
        </div>

        {/* Round Pips (●●○○○) */}
        <div
          className="flex items-center gap-1.5 bg-neutral-900/60 px-2.5 py-1 rounded-full border border-neutral-800"
          title={`Round ${Math.min(currentRound + 1, totalRounds)} of ${totalRounds}`}
        >
          <span className="text-xs text-neutral-400 font-mono font-medium hidden sm:inline mr-1">
            RND {Math.min(currentRound + 1, totalRounds)}/{totalRounds}:
          </span>
          <div className="flex items-center gap-1">
            {Array.from({ length: totalRounds }).map((_, idx) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: round pip indicators
                key={`round-pip-${idx}`}
                className={`text-xs ${
                  idx <= currentRound ? 'text-indigo-400' : 'text-neutral-600'
                }`}
              >
                {idx <= currentRound ? '●' : '○'}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Right: Latency pill, sound slider, chat toggle */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Latency Ping Pill */}
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-mono font-semibold ${pingBadgeClass}`}
          title={`Connection latency: ${pingMs}ms`}
        >
          <span className={`w-2 h-2 rounded-full ${pingDotClass} animate-pulse`} />
          <span>{pingMs}ms</span>
        </div>

        {/* Volume & Mute Controls */}
        <div className="hidden sm:flex items-center gap-1.5 bg-neutral-900/60 border border-neutral-800 rounded-full px-2.5 py-1">
          <button
            type="button"
            onClick={onToggleMute}
            className="text-xs text-neutral-400 hover:text-white transition-colors focus:outline-none"
            aria-label={isMuted ? 'Unmute Audio' : 'Mute Audio'}
          >
            {isMuted || volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              if (isMuted) onToggleMute();
              onVolumeChange(Number(e.target.value));
            }}
            className="w-16 accent-indigo-500 cursor-pointer h-1.5 bg-neutral-700 rounded-lg"
            aria-label="Sound volume"
          />
        </div>

        {/* Chat Toggle Button */}
        {onToggleChat && (
          <button
            type="button"
            onClick={onToggleChat}
            className="relative px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500"
            aria-label="Toggle party chat"
          >
            <span>💬</span>
            <span className="hidden sm:inline">Chat</span>
            {unreadChatCount > 0 && (
              <span className="absolute -top-1 -right-1 px-1.5 py-0.2 bg-indigo-500 text-white rounded-full text-[10px] font-bold shadow-md">
                {unreadChatCount}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
