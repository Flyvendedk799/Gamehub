'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { PodiumPlacement } from '../../../lib/party/party-types';

export interface ResultsShareCardProps {
  roomCode: string;
  roomTitle: string;
  placements: PodiumPlacement[];
  onClose: () => void;
}

export function ResultsShareCard({
  roomCode,
  roomTitle,
  placements,
  onClose,
}: ResultsShareCardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1200 x 630 px standard social card dimension
    canvas.width = 1200;
    canvas.height = 630;

    // Background gradient
    const bgGradient = ctx.createLinearGradient(0, 0, 1200, 630);
    bgGradient.addColorStop(0, '#0a0b0c');
    bgGradient.addColorStop(0.5, '#121417');
    bgGradient.addColorStop(1, '#1c1f24');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, 1200, 630);

    // Glowing accent rings
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(600, 315, 450, 0, Math.PI * 2);
    ctx.stroke();

    // Top Brand & Header
    ctx.fillStyle = '#6366f1';
    ctx.font = 'bold 20px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GAMEHUB PARTY MODE • RESULTS SHOWCASE', 600, 70);

    // Room Title
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 44px "Archivo", sans-serif';
    ctx.fillText(roomTitle, 600, 130);

    // Room Code Pill
    ctx.fillStyle = '#26292c';
    ctx.roundRect(500, 155, 200, 40, 12);
    ctx.fill();
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 20px "JetBrains Mono", monospace';
    ctx.fillText(`CODE: ${roomCode}`, 600, 182);

    // Render 3 Podium Champions (2nd Left, 1st Center, 3rd Right)
    const first = placements.find((p) => p.rank === 1);
    const second = placements.find((p) => p.rank === 2);
    const third = placements.find((p) => p.rank === 3);

    const cards = [
      {
        p: second,
        x: 320,
        y: 280,
        h: 220,
        medal: '🥈 2ND PLACE',
        color: '#94a3b8',
        boxColor: '#1e293b',
      },
      {
        p: first,
        x: 600,
        y: 240,
        h: 260,
        medal: '👑 1ST PLACE CHAMPION',
        color: '#fbbf24',
        boxColor: '#451a03',
      },
      {
        p: third,
        x: 880,
        y: 310,
        h: 190,
        medal: '🥉 3RD PLACE',
        color: '#d97706',
        boxColor: '#271c19',
      },
    ];

    for (const card of cards) {
      if (!card.p) continue;
      // Draw pedestal box
      ctx.fillStyle = card.boxColor;
      ctx.strokeStyle = card.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(card.x - 120, card.y, 240, card.h, 20);
      ctx.fill();
      ctx.stroke();

      // Medal title
      ctx.fillStyle = card.color;
      ctx.font = 'bold 16px "Archivo", sans-serif';
      ctx.fillText(card.medal, card.x, card.y + 40);

      // Name
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px "Archivo", sans-serif';
      ctx.fillText(card.p.displayName, card.x, card.y + 90);

      // Score
      ctx.fillStyle = card.color;
      ctx.font = 'bold 36px "JetBrains Mono", monospace';
      ctx.fillText(`${card.p.finalScore} PTS`, card.x, card.y + 145);
    }

    // Footer Watermark
    ctx.fillStyle = '#64748b';
    ctx.font = '16px "Archivo", sans-serif';
    ctx.fillText('gamehub.gg/party • Real-Time Multiplayer Gaming', 600, 580);

    try {
      setDataUrl(canvas.toDataURL('image/png'));
    } catch {
      // ignore
    }
  }, [roomCode, roomTitle, placements]);

  const handleDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `gamehub-party-${roomCode}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopyLink = async () => {
    try {
      const shareUrl = `${window.location.origin}/party/${roomCode}`;
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        // biome-ignore lint/a11y/useSemanticElements: custom styled modal dialog
        role="dialog"
        aria-modal="true"
        aria-label="Share Results Card"
        tabIndex={-1}
        className="bg-neutral-900 border border-neutral-800 rounded-3xl p-6 max-w-3xl w-full shadow-2xl relative space-y-4"
      >
        <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <span>📸</span> Official Party Results Card (1200×630)
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-neutral-800 text-neutral-400 hover:text-white flex items-center justify-center font-bold text-sm transition-colors"
            aria-label="Close Preview"
          >
            ✕
          </button>
        </div>

        {/* Canvas Display */}
        <div className="w-full aspect-[1200/630] rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-950 shadow-inner flex items-center justify-center">
          <canvas
            ref={canvasRef}
            className="w-full h-full object-contain"
            aria-label="Generated results card preview"
          />
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleCopyLink}
            className="px-4 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white font-medium text-xs sm:text-sm transition-colors flex items-center gap-1.5"
          >
            <span>{copied ? '✓' : '🔗'}</span>
            <span>{copied ? 'Link Copied!' : 'Copy Party Link'}</span>
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!dataUrl}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs sm:text-sm transition-colors shadow-lg shadow-indigo-600/30 flex items-center gap-2"
          >
            <span>💾</span>
            <span>Download High-Res PNG</span>
          </button>
        </div>
      </div>
    </div>
  );
}
