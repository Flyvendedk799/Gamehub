'use client';

import React, { useState } from 'react';
import type { PodiumPlacement } from '../../../lib/party/party-types';
import { ResultsShareCard } from './ResultsShareCard';

export interface PostGameActionSuiteProps {
  roomCode: string;
  roomTitle: string;
  placements: PodiumPlacement[];
  isHost: boolean;
  onRematch: () => void;
  onReturnToLobby: () => void;
}

export function PostGameActionSuite({
  roomCode,
  roomTitle,
  placements,
  isHost,
  onRematch,
  onReturnToLobby,
}: PostGameActionSuiteProps) {
  const [showShareModal, setShowShareModal] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-4">
        {/* Rematch button (Host or participants can request) */}
        {isHost ? (
          <button
            type="button"
            onClick={onRematch}
            className="px-6 py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-neutral-950 font-black text-sm sm:text-base tracking-wide transition-all shadow-xl shadow-emerald-500/25 flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-emerald-400 min-h-[48px]"
          >
            <span>🔄</span> Rematch (Same Party)
          </button>
        ) : (
          <button
            type="button"
            onClick={onRematch}
            className="px-5 py-2.5 rounded-2xl bg-neutral-800 hover:bg-neutral-700 text-white font-bold text-xs sm:text-sm tracking-wide border border-neutral-700 transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-white min-h-[48px]"
          >
            <span>🔄</span> Request Rematch
          </button>
        )}

        {/* Share Results Card button */}
        <button
          type="button"
          onClick={() => setShowShareModal(true)}
          className="px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs sm:text-sm tracking-wide transition-all shadow-lg shadow-indigo-600/30 flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-indigo-400 min-h-[48px]"
        >
          <span>📸</span> Share Results Card
        </button>

        {/* Return to Lobby / Directory */}
        <button
          type="button"
          onClick={onReturnToLobby}
          className="px-5 py-2.5 rounded-2xl bg-neutral-900 hover:bg-neutral-800 text-neutral-300 hover:text-white font-semibold text-xs sm:text-sm border border-neutral-800 transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-neutral-600 min-h-[48px]"
        >
          <span>🏠</span> Return to Lobby
        </button>
      </div>

      {showShareModal && (
        <ResultsShareCard
          roomCode={roomCode}
          roomTitle={roomTitle}
          placements={placements}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </>
  );
}
