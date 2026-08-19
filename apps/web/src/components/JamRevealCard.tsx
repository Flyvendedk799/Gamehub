'use client';

/**
 * One idea on the reveal screen — the moment the jam pays off.
 *
 * The whole card is the tap target (a thumb should never have to find a small
 * heart on a phone held one-handed), and the vote count sits where the thumb
 * already is. Your own card is visibly yours and is not tappable: self-votes
 * would flatten the ranking that decides which idea leads the compiled brief,
 * so the server refuses them and the UI never offers them.
 */

export default function JamRevealCard({
  text,
  votes,
  authorName,
  authorColor,
  isMine,
  disabled,
  onVote,
}: {
  text: string;
  votes: number;
  authorName: string;
  authorColor: string;
  isMine: boolean;
  disabled: boolean;
  onVote: () => void;
}) {
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
          className={`flex-none border px-2.5 py-1 font-mono text-[12px] tabular-nums ${
            votes > 0 ? 'border-signal/50 text-signal' : 'border-hairline text-ink-4'
          }`}
        >
          {votes}
        </span>
      </div>
      <div className="mt-2.5 pl-6 text-left">
        <span className="type-label-xs text-ink-4">
          {authorName}
          {isMine ? ' · you' : ''}
        </span>
      </div>
    </>
  );

  if (isMine) {
    return <div className="border border-edge bg-surface px-4 py-3.5">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onVote}
      disabled={disabled}
      className="tap-target block w-full border border-hairline bg-surface px-4 py-3.5 transition-colors hover:border-signal active:bg-raised disabled:opacity-50"
    >
      {body}
    </button>
  );
}
