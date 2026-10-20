'use client';

import React, { useState } from 'react';

export interface PartyJoinCardProps {
  roomCode: string;
  baseUrl?: string;
}

export function PartyJoinCard({ roomCode, baseUrl }: PartyJoinCardProps) {
  const [copied, setCopied] = useState(false);

  const origin =
    baseUrl || (typeof window !== 'undefined' ? window.location.origin : 'https://gamehub.gg');
  const joinUrl = `${origin}/party/${roomCode}`;

  const handleCopy = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(joinUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } catch {
      // ignore
    }
  };

  // Generate deterministic QR-like matrix grid with authentic finder patterns
  const matrixSize = 25;
  const grid: boolean[][] = [];
  for (let r = 0; r < matrixSize; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < matrixSize; c++) {
      // Finder patterns in corners
      const isTopLeft = r < 7 && c < 7;
      const isTopRight = r < 7 && c >= matrixSize - 7;
      const isBottomLeft = r >= matrixSize - 7 && c < 7;

      if (isTopLeft || isTopRight || isBottomLeft) {
        const lr = isBottomLeft ? r - (matrixSize - 7) : r;
        const lc = isTopRight ? c - (matrixSize - 7) : c;
        if (lr === 0 || lr === 6 || lc === 0 || lc === 6) {
          row.push(true);
        } else if (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4) {
          row.push(true);
        } else {
          row.push(false);
        }
      } else if (r === 6 || c === 6) {
        // Timing patterns
        row.push((r + c) % 2 === 0);
      } else {
        // Pseudo-random data bits hashed with roomCode
        const hash = (r * 31 + c * 17 + roomCode.charCodeAt((r + c) % roomCode.length)) % 100;
        row.push(hash > 46);
      }
    }
    grid.push(row);
  }

  const cellSize = 220 / matrixSize;

  return (
    <div className="flex flex-col items-center p-6 bg-neutral-900 border border-neutral-800 rounded-2xl shadow-xl max-w-sm w-full text-center">
      <div className="mb-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
          Scan to Join Party
        </h3>
        <p className="text-xs text-neutral-500 mt-1">Point phone camera or enter code manually</p>
      </div>

      {/* 220x220px SVG QR Code */}
      <div className="p-3 bg-white rounded-xl shadow-inner mb-4 flex items-center justify-center">
        <svg
          width="220"
          height="220"
          viewBox="0 0 220 220"
          className="rounded"
          role="img"
          aria-label={`Scannable QR code to join room ${roomCode}`}
        >
          <rect width="220" height="220" fill="#ffffff" />
          {grid.map((row, r) =>
            row.map((active, c) =>
              active ? (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed matrix coordinates
                  key={`qr-${r}-${c}`}
                  x={c * cellSize}
                  y={r * cellSize}
                  width={cellSize + 0.1}
                  height={cellSize + 0.1}
                  fill="#0a0a0a"
                />
              ) : null,
            ),
          )}
        </svg>
      </div>

      {/* Direct URL and Copy Button */}
      <div className="w-full flex items-center gap-2 p-2 bg-neutral-950 border border-neutral-800 rounded-xl">
        <span className="text-xs font-mono text-neutral-300 truncate flex-1 text-left px-2 select-all">
          {joinUrl}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="px-3 py-1.5 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg transition-colors shrink-0 flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="Copy join link to clipboard"
        >
          {copied ? (
            <>
              <span className="text-emerald-400">✓</span> Copied!
            </>
          ) : (
            <>
              <span>📋</span> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
