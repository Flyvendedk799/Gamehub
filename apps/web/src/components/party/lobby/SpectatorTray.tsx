'use client';

import React, { useState } from 'react';
import { PARTY_AVATARS, type PartyMember } from '../../../lib/party/party-types';

export interface SpectatorTrayProps {
  spectators: PartyMember[];
}

export function SpectatorTray({ spectators }: SpectatorTrayProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (spectators.length === 0) return null;

  return (
    <div className="w-full bg-neutral-900/60 border border-neutral-800 rounded-xl p-3">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between text-left text-xs font-medium text-neutral-400 hover:text-white transition-colors focus:outline-none"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-800 text-neutral-300 font-mono text-xs">
            👁️ {spectators.length} {spectators.length === 1 ? 'Spectator' : 'Spectators'}
          </span>
          <span className="text-neutral-500 text-xs hidden sm:inline">Watching party match</span>
        </div>
        <span className="text-xs text-neutral-500 font-mono">{isOpen ? '▲ Hide' : '▼ Show'}</span>
      </button>

      {isOpen && (
        <div className="mt-3 pt-3 border-t border-neutral-800 flex flex-wrap gap-2">
          {spectators.map((spec) => {
            const av = PARTY_AVATARS.find((a) => a.id === spec.avatarId) || {
              icon: '👀',
              label: 'Spectator',
            };
            return (
              <div
                key={spec.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-neutral-800/80 rounded-lg border border-neutral-700/60 text-xs text-neutral-300"
              >
                <span>{av.icon}</span>
                <span className="font-medium truncate max-w-[120px]">{spec.displayName}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
