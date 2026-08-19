'use client';

/**
 * Where the room is in the jam, as a row of segments.
 *
 * Without this the only orientation is a "3 / 6" in the header, which people
 * genuinely don't read mid-party. A filling strip answers "how much more of
 * this is there?" at a glance — the question everyone silently has by round
 * three — and gives the round change something visible to move.
 *
 * Keyed on the round's prompt id rather than its index: `jamRoundPlan` never
 * repeats a card within a plan, so those ids are stable identities.
 *
 * The segments are decorative. Screen readers get one sentence instead of a
 * row of anonymous bars, which is the same information without the noise.
 */

export default function JamProgressStrip({
  promptIds,
  current,
  phase,
}: {
  /** Deck card ids for this jam's rounds, in play order. */
  promptIds: string[];
  /** 0-based index of the round being played. */
  current: number;
  phase: 'prompt' | 'reveal';
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="sr-only">
        Question {current + 1} of {promptIds.length}
      </span>
      {promptIds.map((promptId, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <span
            key={promptId}
            aria-hidden="true"
            className={`h-1 flex-1 transition-colors duration-300 ${
              done ? 'bg-ink-4' : active ? 'bg-signal' : 'bg-hairline'
            }`}
          >
            {/* The active segment half-fills during the reveal, so the strip
                reads as "this one is nearly done" rather than jumping a whole
                step only when the next question opens. */}
            {active && phase === 'reveal' && <span className="block h-full w-full bg-signal/50" />}
          </span>
        );
      })}
    </div>
  );
}
