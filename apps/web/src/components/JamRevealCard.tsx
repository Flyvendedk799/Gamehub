'use client';

/**
 * One idea on the reveal screen — the moment the jam pays off.
 *
 * The whole card is the tap target (a thumb should never have to find a small
 * heart on a phone held one-handed), and the vote count sits where the thumb
 * already is. Your own card is visibly yours and is not tappable: self-votes
 * would flatten the ranking that decides which idea leads the compiled brief,
 * so the server refuses them and the UI never offers them.
 *
 * Cards fan in one after another rather than appearing as a block. The reveal
 * is the beat everyone looks up for, and a staggered entry buys a second of
 * "what did people write" instead of a wall of text landing at once. The
 * animation is suppressed entirely under `prefers-reduced-motion`.
 */

import { prefersReducedMotion } from '@/lib/jam-feedback';
import { useEffect, useState } from 'react';

/** Gap between consecutive cards fanning in. */
const STAGGER_MS = 90;

export default function JamRevealCard({
  text,
  votes,
  authorName,
  authorColor,
  isMine,
  isLeading = false,
  youVoted = false,
  revealIndex = 0,
  disabled,
  onVote,
}: {
  text: string;
  votes: number;
  authorName: string;
  authorColor: string;
  isMine: boolean;
  /** Currently the room's favourite — it leads the compiled brief. */
  isLeading?: boolean;
  /** This device has hyped it. Not derivable from room state, by design. */
  youVoted?: boolean;
  /** Position in the reveal, used only to time the entrance. */
  revealIndex?: number;
  disabled: boolean;
  onVote: () => void;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(true);
      return;
    }
    const id = setTimeout(() => setShown(true), revealIndex * STAGGER_MS);
    return () => clearTimeout(id);
  }, [revealIndex]);

  const entrance = shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0';

  const body = (
    <>
      <div className="flex items-start gap-3">
        <span
          className="mt-1.5 h-3 w-3 flex-none"
          style={{ backgroundColor: authorColor }}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 text-left text-[17px] leading-snug text-ink">{text}</p>
        <span
          className={`flex-none border px-2.5 py-1 font-mono text-[12px] tabular-nums transition-colors ${
            youVoted
              ? 'border-signal bg-signal text-chrome'
              : votes > 0
                ? 'border-signal/50 text-signal'
                : 'border-hairline text-ink-4'
          }`}
        >
          {votes}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-2 pl-6 text-left">
        <span className="type-label-xs text-ink-4">
          {authorName}
          {isMine ? ' · you' : ''}
        </span>
        {isLeading && <span className="type-label-xs text-signal">· leading</span>}
      </div>
    </>
  );

  const shell = `transition-all duration-300 ease-out ${entrance}`;

  if (isMine) {
    return (
      <div
        className={`border bg-surface px-4 py-3.5 ${shell} ${
          isLeading ? 'border-signal/60' : 'border-edge'
        }`}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onVote}
      disabled={disabled}
      aria-pressed={youVoted}
      className={`tap-target block w-full border bg-surface px-4 py-3.5 hover:border-signal active:bg-raised disabled:opacity-50 ${shell} ${
        youVoted ? 'border-signal/70' : isLeading ? 'border-signal/40' : 'border-hairline'
      }`}
    >
      {body}
    </button>
  );
}
