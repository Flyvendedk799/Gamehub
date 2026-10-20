'use client';

import React from 'react';

export interface VetoAlertBannerProps {
  initiatorName: string;
  vetoedGameTitle: string;
}

export function VetoAlertBanner({ initiatorName, vetoedGameTitle }: VetoAlertBannerProps) {
  return (
    <div
      role="alert"
      className="w-full p-4 rounded-2xl bg-gradient-to-r from-rose-950/80 via-red-900/60 to-neutral-900 border-2 border-rose-500/60 shadow-xl shadow-rose-950/40 text-white flex items-center gap-3 animate-pulse"
    >
      <div className="w-10 h-10 rounded-xl bg-rose-600/30 border border-rose-500/50 flex items-center justify-center text-xl shrink-0">
        🚫
      </div>
      <div className="flex-1">
        <h4 className="text-sm font-black uppercase tracking-wider text-rose-300">
          Tournament Veto Triggered!
        </h4>
        <p className="text-xs text-neutral-200 mt-0.5">
          <strong className="text-white">{initiatorName}</strong> banned{' '}
          <span className="line-through text-rose-400 font-semibold">{vetoedGameTitle}</span>! The
          runner-up has replaced it in the voting pool.
        </p>
      </div>
    </div>
  );
}
