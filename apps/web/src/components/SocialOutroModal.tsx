'use client';

import { safeFileSlug } from '@/lib/social-outro';
import type { SocialOutroSummary } from '@playforge/shared/social-outro';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SocialOutroExportButton } from './SocialOutroExportButton';
import {
  type SocialOutroFormat,
  SocialOutroPreview,
  type SocialOutroPreviewHandle,
} from './SocialOutroPreview';

interface SocialOutroModalProps {
  open: boolean;
  summary: SocialOutroSummary | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onReload: () => void;
}

/** Derive the public web play path (/p/<slug>) from the API's /v1/play/<slug>. */
function webPlayPath(publishUrl: string | null): string | null {
  if (!publishUrl) return null;
  const parts = publishUrl.split('/').filter(Boolean);
  const slug = parts[parts.length - 1];
  return slug && /^[a-z0-9][a-z0-9-]*$/i.test(slug) ? `/p/${slug}` : null;
}

export function SocialOutroModal({
  open,
  summary,
  loading,
  error,
  onClose,
  onReload,
}: SocialOutroModalProps) {
  const [format, setFormat] = useState<SocialOutroFormat>('9x16');
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<SocialOutroPreviewHandle>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  // Escape to close + focus management + basic focus trap.
  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      lastFocused.current?.focus?.();
    };
  }, [open, onClose]);

  const playPath = webPlayPath(summary?.share.publishUrl ?? null);
  const copyUrl =
    playPath && typeof window !== 'undefined' ? `${window.location.origin}${playPath}` : playPath;

  // Show the nice /p/<slug> link on the card instead of the raw /v1/play path.
  const previewSummary: SocialOutroSummary | null =
    summary && playPath
      ? { ...summary, share: { ...summary.share, publishUrl: playPath } }
      : summary;

  const copyLink = useCallback(() => {
    if (!copyUrl) return;
    void navigator.clipboard?.writeText(copyUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [copyUrl]);

  if (!open) return null;

  const a11ySummary = summary
    ? `Animated outro for ${summary.project.name}: made by ${summary.brandName}, ${summary.metrics.promptLoops} prompts, ${summary.metrics.totalTokens} tokens.`
    : 'Share card preview';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        // biome-ignore lint/a11y/useSemanticElements: a focus-trapped custom modal uses role="dialog" + aria-modal; the native <dialog> has different (showModal) semantics we don't want here
        role="dialog"
        aria-modal="true"
        aria-label="Share your game"
        tabIndex={-1}
        className="w-full max-w-[600px] max-h-[90vh] overflow-y-auto scrollbar-thin rounded-2xl border border-[#242426] bg-[#121214] shadow-2xl outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1f1f22]">
          <div>
            <h2 className="text-sm font-semibold text-[#f4f5f7]">Share your game</h2>
            <p className="text-[11px] text-[#71717a] mt-0.5">
              A 10-second outro that proves you built it with AI.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share dialog"
            className="text-[#52525b] hover:text-[#a1a1aa] text-lg leading-none px-1"
          >
            ✕
          </button>
        </div>

        <div className="p-5">
          {loading && <OutroSkeleton />}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-[#ef4444]">{error}</p>
              <button
                type="button"
                onClick={onReload}
                className="text-xs px-3 py-1.5 rounded-lg border border-[#46e6f0]/30 text-[#46e6f0] hover:bg-[#46e6f0]/10 transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          {!loading && !error && summary && previewSummary && (
            <div className="flex flex-col gap-4">
              {/* Format selector */}
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-[#71717a] uppercase tracking-wider">Format</span>
                <div className="flex rounded-md border border-[#242426] overflow-hidden text-[11px] font-mono">
                  {(
                    [
                      ['9x16', '9:16'],
                      ['1x1', '1:1'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setFormat(val)}
                      aria-pressed={format === val}
                      className={`px-3 py-1 transition-colors ${
                        format === val
                          ? 'bg-[#46e6f0]/15 text-[#46e6f0]'
                          : 'bg-[#1a1a1a] text-[#52525b] hover:text-[#a1a1aa]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div className="flex justify-center rounded-xl border border-[#1f1f22] bg-[#0a0a0a] p-4">
                <SocialOutroPreview
                  ref={previewRef}
                  summary={previewSummary}
                  format={format}
                  className={format === '1x1' ? 'max-h-[340px]' : 'max-h-[440px]'}
                />
              </div>
              <p className="sr-only">{a11ySummary}</p>

              {/* Controls */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => previewRef.current?.replay()}
                  className="flex items-center gap-2 h-10 px-4 rounded-lg border border-[#2c2c2e] text-sm text-[#f4f5f7] hover:bg-[#1a1a1a] transition-colors"
                >
                  <span aria-hidden="true">↻</span> Replay
                </button>
                <div className="flex-1" />
                <SocialOutroExportButton
                  previewRef={previewRef}
                  format={format}
                  fileBaseName={safeFileSlug(summary.project.name)}
                />
              </div>

              {/* Copy link */}
              {copyUrl ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={copyUrl}
                      aria-label="Public play link"
                      onFocus={(e) => e.currentTarget.select()}
                      className={`flex-1 min-w-0 text-xs font-mono px-3 py-2 rounded-lg bg-[#0e0e10] text-[#a1a1aa] border transition-colors ${
                        copied ? 'border-[#b6f24a] text-[#b6f24a]' : 'border-[#242426]'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={copyLink}
                      className={`text-xs px-3 py-2 rounded-lg border font-medium transition-colors ${
                        copied
                          ? 'border-[#b6f24a] bg-[#b6f24a]/10 text-[#b6f24a]'
                          : 'border-[#242426] bg-[#1a1a1a] text-[#a1a1aa] hover:text-[#f4f5f7]'
                      }`}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#52525b]">
                    Anyone with the link can play it now or remix it.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-[#52525b]">
                  Publish your game to get a shareable play link for the outro.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OutroSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse">
      <div className="h-4 w-24 bg-[#1a1a1a] rounded" />
      <div className="h-[420px] bg-[#141416] rounded-xl border border-[#1f1f22]" />
      <div className="flex gap-3">
        <div className="h-10 w-24 bg-[#1a1a1a] rounded-lg" />
        <div className="flex-1" />
        <div className="h-10 w-36 bg-[#1a1a1a] rounded-lg" />
      </div>
      <div className="h-9 bg-[#1a1a1a] rounded-lg" />
    </div>
  );
}
