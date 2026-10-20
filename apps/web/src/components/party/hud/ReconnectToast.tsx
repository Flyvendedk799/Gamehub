'use client';

import React, { useEffect, useState } from 'react';
import type { PartyMember } from '../../../lib/party/party-types';

export interface ReconnectToastProps {
  disconnectedMembers: PartyMember[];
}

export function ReconnectToast({ disconnectedMembers }: ReconnectToastProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (disconnectedMembers.length === 0) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [disconnectedMembers.length]);

  if (disconnectedMembers.length === 0) return null;

  return (
    <div
      role="alert"
      className="fixed top-16 right-4 z-40 space-y-2 max-w-sm w-full pointer-events-none"
    >
      {disconnectedMembers.map((member) => {
        const disconnectedAt = member.disconnectedAt || now;
        const elapsedSec = Math.floor((now - disconnectedAt) / 1000);
        const remainingGraceSec = Math.max(0, 60 - elapsedSec);

        return (
          <div
            key={member.id}
            className="p-3.5 bg-neutral-900/95 border border-amber-500/50 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-md animate-pulse"
          >
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-300 flex items-center justify-center text-lg shrink-0 border border-amber-500/30">
              ⚠️
            </div>
            <div className="flex-1 truncate">
              <h5 className="text-xs font-bold text-white truncate">
                {member.displayName} disconnected
              </h5>
              <p className="text-[11px] text-amber-300 font-mono mt-0.5">
                Grace period: {remainingGraceSec}s remaining
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
