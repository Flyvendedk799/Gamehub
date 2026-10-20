'use client';

import React from 'react';
import { PARTY_ACCENT_COLORS, PARTY_AVATARS } from '../../../lib/party/party-types';

export interface PartyAvatarPickerProps {
  selectedAvatarId: string;
  selectedColor: string;
  onSelectAvatar: (avatarId: string) => void;
  onSelectColor: (color: string) => void;
}

export function PartyAvatarPicker({
  selectedAvatarId,
  selectedColor,
  onSelectAvatar,
  onSelectColor,
}: PartyAvatarPickerProps) {
  return (
    <div className="space-y-4">
      {/* Accent Color Palette */}
      <div>
        <span className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
          Accent Color
        </span>
        <div
          role="radiogroup"
          aria-label="Choose accent color"
          className="flex flex-wrap gap-2.5 items-center"
        >
          {PARTY_ACCENT_COLORS.map((color) => {
            const isSelected = selectedColor.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Select color ${color}`}
                onClick={() => onSelectColor(color)}
                style={{ backgroundColor: color }}
                className={`w-10 h-10 rounded-full transition-transform focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-neutral-900 ${
                  isSelected
                    ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-neutral-950 shadow-lg'
                    : 'opacity-85 hover:opacity-100 hover:scale-105'
                }`}
              />
            );
          })}
        </div>
      </div>

      {/* Avatar Grid (24 avatars) */}
      <div>
        <span className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
          Choose Avatar
        </span>
        <div
          role="radiogroup"
          aria-label="Choose player avatar"
          className="grid grid-cols-6 sm:grid-cols-8 gap-2 p-2 bg-neutral-900/60 rounded-xl border border-neutral-800 max-h-60 overflow-y-auto"
        >
          {PARTY_AVATARS.map((av) => {
            const isSelected = selectedAvatarId === av.id;
            return (
              <button
                // biome-ignore lint/a11y/useSemanticElements: custom styled avatar radio button
                role="radio"
                key={av.id}
                type="button"
                aria-checked={isSelected}
                aria-label={av.label}
                onClick={() => onSelectAvatar(av.id)}
                style={{
                  backgroundColor: isSelected ? selectedColor : undefined,
                }}
                className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all min-w-[48px] min-h-[48px] focus:outline-none focus:ring-2 focus:ring-white ${
                  isSelected
                    ? 'text-white shadow-md scale-105'
                    : 'bg-neutral-800/80 hover:bg-neutral-700/80 text-neutral-200'
                }`}
              >
                <span className="text-2xl select-none" role="img" aria-label={av.label}>
                  {av.icon}
                </span>
                <span className="text-[10px] font-medium tracking-tight mt-1 truncate max-w-full">
                  {av.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
