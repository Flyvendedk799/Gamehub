'use client';

import React, { useState } from 'react';

export interface VetoActionButtonProps {
  hasVetoAvailable: boolean;
  onTriggerVeto: () => void;
  disabled?: boolean;
}

export function VetoActionButton({
  hasVetoAvailable,
  onTriggerVeto,
  disabled = false,
}: VetoActionButtonProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  const handleConfirm = () => {
    setShowConfirm(false);
    onTriggerVeto();
  };

  if (!hasVetoAvailable) {
    return (
      <div className="text-center py-1">
        <span className="text-xs text-neutral-500 italic">
          🚫 1-time tournament veto already used
        </span>
      </div>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setShowConfirm(true)}
        className="px-4 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/30 text-xs sm:text-sm font-bold tracking-wide transition-all flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-rose-500 min-h-[48px]"
        aria-label="Use 1-time tournament veto"
      >
        <span>🚫</span>
        <span>Use Tournament Veto (1 Left)</span>
      </button>

      {/* Confirmation Modal */}
      {showConfirm && (
        // biome-ignore lint/a11y/useSemanticElements: modal dialog container
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm Tournament Veto"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-2xl p-6 max-w-sm w-full text-center shadow-2xl">
            <div className="w-12 h-12 rounded-full bg-rose-500/20 border border-rose-500/30 text-2xl flex items-center justify-center mx-auto mb-3">
              🚫
            </div>
            <h3 className="text-lg font-extrabold text-white">Trigger Tournament Veto?</h3>
            <p className="text-xs text-neutral-300 mt-2 mb-6 leading-relaxed">
              You only get <strong>ONE</strong> veto for the entire party match. This will
              immediately ban the leading minigame and swap in the runner-up.
            </p>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-xs sm:text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-xs sm:text-sm transition-colors shadow-lg shadow-rose-600/30"
              >
                Yes, Veto It!
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
