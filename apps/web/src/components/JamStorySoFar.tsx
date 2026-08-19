'use client';

/**
 * What the room has already decided, collapsed by default.
 *
 * By round four nobody remembers what they said the setting was, and answers
 * start contradicting each other by accident rather than on purpose. This puts
 * the story back within one tap — collapsed so it never competes with the
 * question, which is the only thing that should own the screen during a round.
 *
 * Shows the ROOM's leading idea per question (the most-hyped one), because that
 * is what the compiled brief will lead with too. Seeing the same ranking here
 * and in the finished game is what makes the votes feel like they mattered.
 */

import type { JamAnswer, JamPlayer } from '@playforge/shared/game-jam';
import { jamPromptById } from '@playforge/shared/game-jam';
import { useState } from 'react';

export default function JamStorySoFar({
  roundPromptIds,
  currentRound,
  answers,
  players,
  colorHex,
}: {
  roundPromptIds: string[];
  /** Rounds strictly before this one are settled and safe to show. */
  currentRound: number;
  answers: JamAnswer[];
  players: JamPlayer[];
  colorHex: (colorId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const byId = new Map(players.map((p) => [p.id, p]));

  const settled = roundPromptIds
    .slice(0, currentRound)
    .map((promptId, round) => {
      const card = jamPromptById(promptId);
      const forRound = answers
        .filter((a) => a.round === round && a.text.trim() !== '')
        .sort((a, b) => b.votes - a.votes);
      const lead = forRound[0];
      if (!card || !lead) return null;
      return { card, lead, alsoRan: forRound.length - 1, author: byId.get(lead.playerId) ?? null };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (settled.length === 0) return null;

  return (
    <div className="mt-10 border-t border-hairline pt-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap-target flex w-full items-center justify-between text-left"
      >
        <span className="type-label-xs text-ink-4">The story so far · {settled.length}</span>
        <span className="font-mono text-[11px] text-ink-4">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <ul className="mt-4 flex flex-col gap-3.5">
          {settled.map((entry) => (
            <li key={entry.card.id}>
              <div className="type-label-xs text-ink-4">{entry.card.question}</div>
              <div className="mt-1.5 flex items-start gap-2.5">
                <span
                  className="mt-1.5 h-2.5 w-2.5 flex-none"
                  style={{ backgroundColor: colorHex(entry.author?.color ?? 'cyan') }}
                  aria-hidden="true"
                />
                <p className="min-w-0 flex-1 text-[15px] leading-snug text-ink-2">
                  {entry.lead.text}
                  {entry.alsoRan > 0 && (
                    <span className="ml-1.5 font-mono text-[11px] text-ink-4">
                      +{entry.alsoRan} more
                    </span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
