'use client';

import React from 'react';
import { type FloatingReaction, PARTY_EMOJIS } from '../../../lib/party/party-types';

export interface FloatingEmojiDockProps {
  reactions: FloatingReaction[];
  comboBlastActive: boolean;
  onSendEmoji: (emoji: string) => boolean;
}

export function FloatingEmojiDock({
  reactions,
  comboBlastActive,
  onSendEmoji,
}: FloatingEmojiDockProps) {
  return (
    <>
      {/* Combo Blast Fullscreen / Prominent Banner */}
      {comboBlastActive && (
        <div
          // biome-ignore lint/a11y/useSemanticElements: custom visual status alert banner
          role="status"
          aria-live="assertive"
          className="fixed top-20 inset-x-0 z-40 flex items-center justify-center pointer-events-none"
        >
          <div className="px-6 py-3 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 border-2 border-yellow-300 text-white font-black text-xl sm:text-2xl uppercase tracking-widest shadow-2xl shadow-orange-500/50 animate-bounce flex items-center gap-3">
            <span className="text-3xl">🔥🔥🔥</span>
            <span>PARTY COMBO BLAST!</span>
            <span className="text-3xl">🔥🔥🔥</span>
          </div>
        </div>
      )}

      {/* Floating Reaction Particles: strictly clamped to outer 15% gutters (left 0-15%, right 85-100%) */}
      <div aria-hidden="true" className="fixed inset-0 pointer-events-none z-30 overflow-hidden">
        {reactions.map((rx) => {
          // Calculate rising float animation with inline styles
          const elapsed = Date.now() - rx.createdAt;
          const progress = Math.min(1, elapsed / 3000); // 0 to 1 over 3s
          const bottomPercent = 15 + progress * 70; // Floats up from bottom 15% to 85%
          const opacity = progress > 0.8 ? (1 - progress) * 5 : 1;
          const scale = 0.8 + Math.sin(progress * Math.PI) * 0.4;

          return (
            <div
              key={rx.id}
              className="absolute transition-transform flex flex-col items-center"
              style={{
                left: `${rx.xPercent}%`,
                bottom: `${bottomPercent}%`,
                opacity,
                transform: `scale(${scale})`,
              }}
            >
              <span className="text-3xl filter drop-shadow-lg">{rx.emoji}</span>
              <span className="text-[10px] font-bold bg-neutral-900/80 text-white px-1.5 py-0.2 rounded-full border border-neutral-700/60 mt-0.5 truncate max-w-[80px]">
                {rx.senderName}
              </span>
            </div>
          );
        })}
      </div>

      {/* Bottom Sticky Reaction Bar */}
      <div className="fixed bottom-3 right-3 sm:right-6 z-30 flex items-center gap-1.5 p-1.5 bg-neutral-950/85 backdrop-blur-md border border-neutral-800 rounded-2xl shadow-2xl">
        {PARTY_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onSendEmoji(emoji)}
            className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-neutral-900/80 hover:bg-neutral-800 hover:scale-110 active:scale-95 transition-all text-xl sm:text-2xl flex items-center justify-center border border-neutral-700/60 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label={`Send ${emoji} reaction`}
          >
            <span>{emoji}</span>
          </button>
        ))}
      </div>
    </>
  );
}
