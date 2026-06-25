'use client';

import { type RefObject, useState } from 'react';
import type { SocialOutroFormat, SocialOutroPreviewHandle } from './SocialOutroPreview';

const DURATION_S = 10;

/** Pick the best supported WebM codec, or null if MediaRecorder/WebM is unusable. */
function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function saveOrShare(blob: Blob, filename: string): Promise<void> {
  const mime = blob.type || 'application/octet-stream';
  // Offer the native share sheet when it can take files (mobile), else download.
  try {
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string }) => Promise<void>;
    };
    if (nav.canShare && nav.share) {
      const file = new File([blob], filename, { type: mime });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename });
        return;
      }
    }
  } catch {
    /* user cancelled or share failed — fall back to download */
  }
  triggerDownload(blob, filename);
}

interface ExportProps {
  previewRef: RefObject<SocialOutroPreviewHandle>;
  format: SocialOutroFormat;
  fileBaseName: string;
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'recording'; progress: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export function SocialOutroExportButton({ previewRef, format, fileBaseName }: ExportProps) {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  const suffix = format === '1x1' ? '1x1' : '9x16';

  async function exportPng(handle: SocialOutroPreviewHandle): Promise<void> {
    const canvas = handle.getCanvas();
    if (!canvas) throw new Error('Preview not ready');
    // Render the final lockup frame for the still.
    handle.renderAt(9.6);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Could not render image');
    await saveOrShare(blob, `social-outro-${fileBaseName}-${suffix}.png`);
  }

  async function exportVideo(): Promise<void> {
    const handle = previewRef.current;
    const canvas = handle?.getCanvas();
    if (!handle || !canvas) {
      setState({ kind: 'error', message: 'Preview not ready yet.' });
      return;
    }
    const mime = pickMimeType();
    let success = false;
    let activeRecorder: MediaRecorder | null = null;
    handle.pausePreview();
    try {
      // Ensure brand fonts are loaded so the EXPORTED frames match the preview
      // (otherwise the first frames record with fallback fonts).
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        await document.fonts.ready;
      }
      if (!mime || typeof canvas.captureStream !== 'function') {
        // No WebM recording support — fall back to a PNG still.
        await exportPng(handle);
        success = true;
        setState({ kind: 'done' });
        return;
      }
      const stream = canvas.captureStream(60);
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      activeRecorder = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise<void>((res) => {
        recorder.onstop = () => res();
      });
      setState({ kind: 'recording', progress: 0 });
      recorder.start();

      // Drive a clean 10s pass at real time; MediaRecorder samples the canvas.
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const frame = (now: number) => {
          const t = Math.min(DURATION_S, (now - start) / 1000);
          handle.renderAt(t);
          setState({ kind: 'recording', progress: t / DURATION_S });
          if (t >= DURATION_S) {
            resolve();
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });

      recorder.stop();
      activeRecorder = null;
      await stopped;
      const blob = new Blob(chunks, { type: mime });
      await saveOrShare(blob, `social-outro-${fileBaseName}-${suffix}.webm`);
      success = true;
      setState({ kind: 'done' });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    } finally {
      // Always stop a dangling recorder + resume the preview, even on error.
      if (activeRecorder && activeRecorder.state !== 'inactive') {
        try {
          activeRecorder.stop();
        } catch {
          /* already stopped */
        }
      }
      handle.resumePreview();
      if (success) setTimeout(() => setState({ kind: 'idle' }), 2500);
    }
  }

  const recording = state.kind === 'recording';
  const label = recording
    ? `Recording… ${Math.round(state.progress * 100)}%`
    : state.kind === 'done'
      ? 'Saved ✓'
      : 'Download video';

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void exportVideo()}
        disabled={recording}
        className="flex items-center justify-center gap-2 h-11 md:h-10 px-4 rounded-lg bg-[#46e6f0] text-[#06181a] text-sm font-semibold hover:bg-[#5beef7] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {!recording && state.kind !== 'done' && <span aria-hidden="true">↓</span>}
        {label}
      </button>
      {state.kind === 'error' && <p className="text-[11px] text-[#ef4444]">{state.message}</p>}
    </div>
  );
}
