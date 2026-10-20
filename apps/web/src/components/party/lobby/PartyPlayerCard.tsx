'use client';

import React from 'react';
import { PARTY_AVATARS, type PartyMember, type PlayerStatus } from '../../../lib/party/party-types';

export interface PartyPlayerCardProps {
  member: PartyMember;
  isCurrentUser: boolean;
  canManage: boolean; // host can kick
  onKick?: (memberId: string) => void;
}

export function PartyPlayerCard({
  member,
  isCurrentUser,
  canManage,
  onKick,
}: PartyPlayerCardProps) {
  const avatarDef = PARTY_AVATARS.find((a) => a.id === member.avatarId) || {
    id: member.avatarId,
    label: 'Player',
    icon: '🎮',
  };

  const renderStatusPill = (status: PlayerStatus) => {
    switch (status) {
      case 'READY':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.3)] animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            READY
          </span>
        );
      case 'DISCONNECTED_GRACE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-dashed border-amber-500/50 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            RECONNECTING
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-neutral-800 text-neutral-400 border border-neutral-700">
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
            NOT READY
          </span>
        );
    }
  };

  return (
    <div
      className={`relative flex flex-col items-center justify-between p-4 rounded-2xl bg-neutral-900 border transition-all duration-200 ${
        member.status === 'READY'
          ? 'border-emerald-500/40 shadow-lg'
          : member.status === 'DISCONNECTED_GRACE'
            ? 'border-amber-500/50 border-dashed opacity-80'
            : 'border-neutral-800'
      } ${isCurrentUser ? 'ring-2 ring-indigo-500/50' : ''}`}
      style={{
        boxShadow:
          member.status === 'READY' ? `0 4px 20px -2px ${member.avatarColor}33` : undefined,
      }}
    >
      {/* Top row: Host crown / You badge & Host kick button */}
      <div className="w-full flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          {member.isHost && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-0.5"
              title="Host"
            >
              👑 HOST
            </span>
          )}
          {isCurrentUser && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              YOU
            </span>
          )}
        </div>

        {canManage && !member.isHost && onKick && (
          <button
            type="button"
            onClick={() => onKick(member.id)}
            title={`Kick ${member.displayName}`}
            className="text-[11px] text-rose-400 hover:text-rose-300 p-1 rounded hover:bg-rose-500/10 transition-colors focus:outline-none focus:ring-1 focus:ring-rose-500"
            aria-label={`Kick ${member.displayName}`}
          >
            ✕ Kick
          </button>
        )}
      </div>

      {/* Avatar Circle */}
      <div
        className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl flex items-center justify-center text-3xl sm:text-4xl shadow-md my-2 transition-transform hover:scale-105"
        style={{
          backgroundColor: member.avatarColor,
        }}
        role="img"
        aria-label={`${member.displayName}'s avatar: ${avatarDef.label}`}
      >
        <span>{avatarDef.icon}</span>
      </div>

      {/* Name & Score */}
      <div className="text-center w-full px-1">
        <h4 className="font-bold text-white text-sm sm:text-base truncate">{member.displayName}</h4>
        <p className="text-xs font-mono text-neutral-400 mt-0.5">{member.score} pts</p>
      </div>

      {/* Status Pill */}
      <div className="mt-3">{renderStatusPill(member.status)}</div>
    </div>
  );
}
