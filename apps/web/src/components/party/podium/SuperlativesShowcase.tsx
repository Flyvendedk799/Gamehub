'use client';

import React from 'react';
import type { SuperlativeAward, SuperlativeBadgeId } from '../../../lib/party/party-types';

export interface SuperlativesShowcaseProps {
  awards: SuperlativeAward[];
}

const BADGE_CONFIG: Record<SuperlativeBadgeId, { icon: string; border: string; glow: string }> = {
  SHARPSHOOTER: {
    icon: '🎯',
    border: 'border-rose-500/40',
    glow: 'bg-rose-500/10',
  },
  CLUTCH_MASTER: {
    icon: '⚡',
    border: 'border-amber-500/40',
    glow: 'bg-amber-500/10',
  },
  CHAOS_AGENT: {
    icon: '🌪️',
    border: 'border-purple-500/40',
    glow: 'bg-purple-500/10',
  },
  SPEED_DEMON: {
    icon: '🏎️',
    border: 'border-cyan-500/40',
    glow: 'bg-cyan-500/10',
  },
  PACIFIST: {
    icon: '🪷',
    border: 'border-emerald-500/40',
    glow: 'bg-emerald-500/10',
  },
  UNLUCKY_LEGEND: {
    icon: '💔',
    border: 'border-slate-500/40',
    glow: 'bg-slate-500/10',
  },
};

export function SuperlativesShowcase({ awards }: SuperlativesShowcaseProps) {
  if (awards.length === 0) return null;

  return (
    <div className="w-full space-y-3">
      <div className="text-center sm:text-left">
        <h3 className="text-base sm:text-lg font-bold text-white uppercase tracking-wider flex items-center justify-center sm:justify-start gap-2">
          <span>🏅</span> Match Superlatives
        </h3>
        <p className="text-xs text-neutral-400 mt-0.5">
          Special recognition for outstanding gameplay feats
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {awards.map((award) => {
          const config = BADGE_CONFIG[award.badgeId] || {
            icon: '🎖️',
            border: 'border-neutral-700',
            glow: 'bg-neutral-800/40',
          };

          return (
            <div
              key={award.badgeId}
              className={`p-4 rounded-2xl border ${config.border} ${config.glow} bg-neutral-900/80 backdrop-blur-sm flex flex-col justify-between transition-all hover:scale-[1.02] shadow-lg`}
            >
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-xl bg-neutral-950/80 border border-neutral-800 flex items-center justify-center text-2xl shrink-0 shadow-inner">
                  <span>{config.icon}</span>
                </div>
                <div className="truncate">
                  <h4 className="text-sm font-extrabold text-white truncate tracking-tight">
                    {award.title}
                  </h4>
                  <p className="text-xs font-bold text-indigo-400 truncate mt-0.5">
                    {award.recipientName}
                  </p>
                  <p className="text-[11px] text-neutral-400 mt-1 line-clamp-2 leading-relaxed">
                    {award.description}
                  </p>
                </div>
              </div>

              <div className="mt-3 pt-2.5 border-t border-neutral-800/60 flex items-center justify-between text-[11px] font-mono">
                <span className="text-neutral-500 uppercase tracking-widest text-[9px]">
                  Highlight
                </span>
                <span className="text-amber-300 font-bold">{award.statHighlight}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
