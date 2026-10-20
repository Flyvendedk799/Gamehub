'use client';

import { type FormEvent, useState } from 'react';
import { type ChatMessage, PARTY_AVATARS } from '../../../lib/party/party-types';

export interface PartyChatDrawerProps {
  isOpen: boolean;
  messages: ChatMessage[];
  currentMemberId: string | null;
  onClose: () => void;
  onSendMessage: (text: string) => void;
}

export function PartyChatDrawer({
  isOpen,
  messages,
  currentMemberId,
  onClose,
  onSendMessage,
}: PartyChatDrawerProps) {
  const [inputText, setInputText] = useState('');

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  if (!isOpen) return null;

  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: custom slide-over chat drawer dialog
      role="dialog"
      aria-modal="true"
      aria-label="Party Chat"
      className="fixed inset-y-0 right-0 z-50 w-full sm:w-80 bg-neutral-950/95 backdrop-blur-md border-l border-neutral-800 shadow-2xl flex flex-col"
    >
      {/* Header */}
      <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <span>💬</span> Party Chat
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-neutral-900 text-neutral-400 hover:text-white flex items-center justify-center transition-colors focus:outline-none focus:ring-1 focus:ring-white"
          aria-label="Close Chat"
        >
          ✕
        </button>
      </div>

      {/* Messages Feed */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center py-12 text-xs text-neutral-500">
            No messages yet. Say hello to your party!
          </div>
        ) : (
          messages.map((msg) => {
            const isSelf = msg.senderId === currentMemberId;
            const av = PARTY_AVATARS.find((a) => a.id === msg.avatarId) || {
              icon: '👤',
            };

            return (
              <div key={msg.id} className={`flex gap-2.5 ${isSelf ? 'flex-row-reverse' : ''}`}>
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0 shadow"
                  style={{ backgroundColor: msg.avatarColor }}
                >
                  {av.icon}
                </div>
                <div
                  className={`max-w-[75%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                    isSelf
                      ? 'bg-indigo-600 text-white rounded-tr-none'
                      : 'bg-neutral-900 text-neutral-200 border border-neutral-800 rounded-tl-none'
                  }`}
                >
                  <span className="block text-[10px] font-bold opacity-75 mb-0.5">
                    {msg.senderName}
                  </span>
                  <span className="break-words">{msg.text}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input Box */}
      <form
        onSubmit={handleSend}
        className="p-3 border-t border-neutral-800 flex items-center gap-2"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Message party..."
          maxLength={140}
          className="flex-1 h-10 px-3 rounded-xl bg-neutral-900 border border-neutral-700 text-white placeholder-neutral-500 text-xs focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={!inputText.trim()}
          className="h-10 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-bold transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  );
}
