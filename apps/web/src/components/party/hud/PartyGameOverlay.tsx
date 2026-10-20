'use client';

import React, { useState } from 'react';
import type {
  ChatMessage,
  FloatingReaction,
  PartyMember,
  PartyRoom,
  SoundBiteId,
} from '../../../lib/party/party-types';
import { FloatingEmojiDock } from './FloatingEmojiDock';
import { MiniLeaderboardTray } from './MiniLeaderboardTray';
import { PartyChatDrawer } from './PartyChatDrawer';
import { PartyHeaderBar } from './PartyHeaderBar';
import { ReconnectToast } from './ReconnectToast';
import { SoundBiteBar } from './SoundBiteBar';

export interface PartyGameOverlayProps {
  room: PartyRoom;
  currentMember: PartyMember | null;
  members: PartyMember[];
  pingMs: number;
  activeMinigameId: string | null;
  volume: number;
  isMuted: boolean;
  canPlaySound: boolean;
  cooldownRemainingMs: number;
  reactions: FloatingReaction[];
  comboBlastActive: boolean;
  chatMessages: ChatMessage[];
  disconnectedMembers: PartyMember[];
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
  onPlaySound: (id: SoundBiteId) => boolean;
  onSendEmoji: (emoji: string) => boolean;
  onSendChat: (text: string) => void;
  onTriggerVeto?: () => void;
}

export function PartyGameOverlay({
  room,
  currentMember,
  members,
  pingMs,
  activeMinigameId,
  volume,
  isMuted,
  canPlaySound,
  cooldownRemainingMs,
  reactions,
  comboBlastActive,
  chatMessages,
  disconnectedMembers,
  onVolumeChange,
  onToggleMute,
  onPlaySound,
  onSendEmoji,
  onSendChat,
}: PartyGameOverlayProps) {
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="relative w-full h-full min-h-[500px] flex flex-col bg-neutral-950 overflow-hidden select-none">
      {/* Top Header Bar */}
      <PartyHeaderBar
        roomCode={room.roomCode}
        currentRound={room.playlist.currentRoundIndex}
        totalRounds={room.playlist.totalRounds}
        pingMs={pingMs}
        volume={volume}
        isMuted={isMuted}
        unreadChatCount={0}
        onVolumeChange={onVolumeChange}
        onToggleMute={onToggleMute}
        onToggleChat={() => setChatOpen(!chatOpen)}
      />

      {/* Main Game Stage Area with 16:9 Canvas Scale */}
      <div className="relative flex-1 flex items-center justify-center p-2 sm:p-4 bg-void">
        {/* Active Minigame Container */}
        <div className="relative w-full max-w-5xl aspect-video bg-neutral-900 rounded-2xl border border-neutral-800 shadow-2xl overflow-hidden flex flex-col items-center justify-center">
          <div className="text-center p-6 space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-3xl flex items-center justify-center mx-auto text-indigo-400">
              🎮
            </div>
            <div>
              <span className="text-xs font-mono uppercase tracking-widest text-indigo-400">
                Live Party Minigame
              </span>
              <h3 className="text-2xl sm:text-3xl font-black text-white capitalize mt-1">
                {activeMinigameId ? activeMinigameId.replace(/-/g, ' ') : 'Party Match'}
              </h3>
            </div>
            <p className="text-xs text-neutral-400 max-w-md mx-auto">
              Play using your game controls or on-screen actions. Scores update live on the
              leaderboard!
            </p>
          </div>
        </div>

        {/* Collapsible Mini Leaderboard */}
        <MiniLeaderboardTray members={members} currentMemberId={currentMember?.id ?? null} />

        {/* Reconnection Grace Banner Toast */}
        <ReconnectToast disconnectedMembers={disconnectedMembers} />

        {/* Floating Emoji Reaction Dock & Combo Blast */}
        <FloatingEmojiDock
          reactions={reactions}
          comboBlastActive={comboBlastActive}
          onSendEmoji={onSendEmoji}
        />

        {/* Web Audio Soundbite Trigger Bar */}
        {room.soundBitesEnabled && (
          <SoundBiteBar
            canPlaySound={canPlaySound}
            cooldownRemainingMs={cooldownRemainingMs}
            onPlaySound={onPlaySound}
          />
        )}

        {/* Party Chat Drawer */}
        <PartyChatDrawer
          isOpen={chatOpen}
          messages={chatMessages}
          currentMemberId={currentMember?.id ?? null}
          onClose={() => setChatOpen(false)}
          onSendMessage={onSendChat}
        />
      </div>
    </div>
  );
}
