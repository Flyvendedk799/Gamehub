'use client';

import React, { useState } from 'react';
import type { PlaylistMode } from '../../../lib/party/party-types';
import { PartyJoinCard } from './PartyJoinCard';

export interface PartyLobbyHeaderProps {
  roomCode: string;
  roomTitle: string;
  isHost: boolean;
  hostName: string;
  playlistMode: PlaylistMode;
  totalRounds?: number;
}

export function PartyLobbyHeader({
  roomCode,
  roomTitle,
  isHost,
  hostName,
  playlistMode,
  totalRounds = 1,
}: PartyLobbyHeaderProps) {
  const [copied, setCopied] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);

  const playlistLabels: Record<PlaylistMode, string> = {
    SINGLE_GAME: 'Single Game (1 Round)',
    BEST_OF_3: 'Best of 3 (3 Rounds)',
    BEST_OF_5: 'Best of 5 (5 Rounds)',
    POINTS_GAUNTLET: `Points Gauntlet (${totalRounds} Rounds)`,
  };

  const handleCopyCode = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(roomCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // ignore
    }
  };

  return (
    <header className="relative w-full bg-neutral-900/80 backdrop-blur border-b border-neutral-800 p-4 sm:p-6 rounded-2xl">
      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Room Title & Host Info */}
        <div className="text-center md:text-left">
          <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 mb-1">
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{roomTitle}</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              🎮 {playlistLabels[playlistMode] || playlistMode}
            </span>
          </div>
          <p className="text-xs sm:text-sm text-neutral-400 flex items-center justify-center md:justify-start gap-1.5">
            <span role="img" aria-label="Host crown">
              👑
            </span>
            Hosted by <strong className="text-neutral-200">{hostName}</strong>
            {isHost && (
              <span className="ml-1 text-[10px] uppercase font-bold bg-amber-500/20 text-amber-300 px-1.5 py-0.2 rounded">
                You (Host)
              </span>
            )}
          </p>
        </div>

        {/* Room Code Display & Share Tools */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-center sm:items-end">
            <span className="text-[10px] uppercase tracking-widest text-neutral-400 font-mono">
              Room Code
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-3xl sm:text-4xl font-black font-mono tracking-widest text-white px-3 py-1 bg-neutral-950 border border-neutral-700 rounded-xl shadow-inner select-all">
                {roomCode}
              </span>
              <button
                type="button"
                onClick={handleCopyCode}
                title="Copy Room Code"
                className="w-11 h-11 flex items-center justify-center rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition-all border border-neutral-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Copy room code"
              >
                {copied ? (
                  <span className="text-emerald-400 font-bold text-sm">✓</span>
                ) : (
                  <span className="text-base">📋</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowQrModal(true)}
                title="Show QR Code"
                className="w-11 h-11 flex items-center justify-center rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white transition-all border border-neutral-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label="Show QR Code modal"
              >
                <span className="text-base">📱</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* QR Code Modal */}
      {showQrModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowQrModal(false);
          }}
        >
          <div
            // biome-ignore lint/a11y/useSemanticElements: custom styled modal dialog
            role="dialog"
            aria-modal="true"
            aria-label="Room QR Code"
            className="relative"
          >
            <button
              type="button"
              onClick={() => setShowQrModal(false)}
              className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-neutral-800 text-white border border-neutral-600 flex items-center justify-center font-bold text-sm hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-white"
              aria-label="Close QR Modal"
            >
              ✕
            </button>
            <PartyJoinCard roomCode={roomCode} />
          </div>
        </div>
      )}
    </header>
  );
}
