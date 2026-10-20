'use client';

import type { ChangeEvent } from 'react';
import React from 'react';
import { sanitizeDisplayName } from '../../../lib/party/party-types';

export interface PartyNameInputProps {
  value: string;
  onChange: (val: string) => void;
  existingNames?: string[];
  placeholder?: string;
  disabled?: boolean;
}

export function PartyNameInput({
  value,
  onChange,
  existingNames = [],
  placeholder = 'Enter your handle...',
  disabled = false,
}: PartyNameInputProps) {
  const { cleanName, hasProfanity } = sanitizeDisplayName(value);
  const trimmed = value.trim();
  const isDuplicate = existingNames.some((n) => n.trim().toLowerCase() === trimmed.toLowerCase());

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw.length <= 20) {
      onChange(raw);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <label
          htmlFor="party-player-name"
          className="text-xs font-semibold uppercase tracking-wider text-neutral-400"
        >
          Player Handle
        </label>
        <span
          className={`text-xs font-mono ${
            value.length >= 20 ? 'text-amber-400' : 'text-neutral-500'
          }`}
          aria-live="polite"
        >
          {value.length}/20
        </span>
      </div>

      <div className="relative">
        <input
          id="party-player-name"
          type="text"
          value={value}
          onChange={handleChange}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={20}
          className="w-full h-12 px-4 rounded-xl bg-neutral-900 border border-neutral-700 text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-medium text-base disabled:opacity-50"
        />
      </div>

      {hasProfanity && (
        <p className="text-xs text-amber-400 flex items-center gap-1 font-medium" role="alert">
          <span>⚠️</span> Inappropriate words will appear censored as: &ldquo;{cleanName}&rdquo;
        </p>
      )}

      {isDuplicate && trimmed.length > 0 && (
        <output className="text-xs text-sky-400 flex items-center gap-1 font-medium block">
          <span>ℹ️</span> Name in use — will appear as &ldquo;{trimmed} (2)&rdquo;
        </output>
      )}
    </div>
  );
}
