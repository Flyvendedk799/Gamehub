'use client';

import { jamColorForSeat } from '@playforge/shared/game-jam';

/**
 * The room's roster, compressed to a row of colored squares for the header.
 *
 * The party's whole mental model is "I'm the cyan one", so the dot is the
 * player's identity everywhere — here, on the reveal cards, and (via the
 * compiled brief) on their character in the finished game. A disconnected
 * player fades rather than disappearing: a phone that locked its screen has
 * not left the room, and removing them mid-round would read as a kick.
 */

interface Player {
  id: string;
  name: string;
  color: string;
  connected: boolean;
}

/** Hex for a palette id, resolved through the shared seat palette. */
function colorHex(colorId: string): string {
  for (let seat = 0; seat < 8; seat++) {
    const entry = jamColorForSeat(seat);
    if (entry.id === colorId) return entry.hex;
  }
  return jamColorForSeat(0).hex;
}

export default function JamPlayerDots({
  players,
  me,
  max = 6,
}: {
  players: Player[];
  me?: string | null;
  max?: number;
}) {
  const shown = players.slice(0, max);
  const overflow = players.length - shown.length;

  return (
    <div
      className="flex flex-none items-center gap-1"
      title={players.map((p) => p.name).join(', ')}
    >
      {shown.map((p) => (
        <span
          key={p.id}
          aria-label={p.name}
          className={`h-2.5 w-2.5 transition-opacity ${p.connected ? 'opacity-100' : 'opacity-30'} ${
            p.id === me ? 'ring-1 ring-ink ring-offset-2 ring-offset-chrome' : ''
          }`}
          style={{ backgroundColor: colorHex(p.color) }}
        />
      ))}
      {overflow > 0 && <span className="font-mono text-[10px] text-ink-4">+{overflow}</span>}
    </div>
  );
}
