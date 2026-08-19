'use client';

/**
 * "Here's what we're about to build" — the host's last look before a build runs.
 *
 * A jam build costs real credits and takes minutes, and until the host sees the
 * compiled brief they have no idea whether the room produced a game or a pile of
 * in-jokes that contradict each other. The API has always been able to compile
 * the brief without building it; this is the screen that finally shows it.
 *
 * It also quietly teaches what the room made: seeing every idea land in a real
 * brief, attributed, is the moment people realise their weird answer actually
 * went somewhere.
 */

import { type CompiledJamBrief, describeJamError, getJamBrief } from '@/lib/jam';
import { useEffect, useState } from 'react';

export default function JamBriefPreview({
  code,
  seatToken,
  busy,
  onConfirm,
  onCancel,
}: {
  code: string;
  seatToken: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [brief, setBrief] = useState<CompiledJamBrief | null>(null);
  const [canBuild, setCanBuild] = useState(false);
  const [error, setError] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getJamBrief(code, seatToken)
      .then((res) => {
        if (cancelled) return;
        setBrief(res.brief);
        setCanBuild(res.canBuild);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeJamError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [code, seatToken]);

  if (error) {
    return (
      <div className="pt-10">
        <p className="border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">{error}</p>
        <button
          type="button"
          onClick={onCancel}
          className="tap-target mt-4 w-full border border-edge px-6 py-3.5 text-sm font-semibold text-ink"
        >
          Back to the ideas
        </button>
      </div>
    );
  }

  if (!brief) {
    return (
      <div className="pt-20 text-center">
        <span className="animate-pulse font-mono text-[11px] tracking-[.2em] text-ink-4">
          COMPILING THE BRIEF…
        </span>
      </div>
    );
  }

  return (
    <div className="pt-8">
      <div className="type-label-xs text-ink-4">About to build</div>
      <h2 className="type-display mt-2 text-[34px] leading-[1.05] text-ink sm:text-[42px]">
        {brief.name}
      </h2>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-3">
        A local co-op game for {brief.playerCount} players on one screen, in{' '}
        {brief.engine === 'three' ? '3D' : '2D'}. Every idea from this room is in the brief.
      </p>

      <button
        type="button"
        onClick={() => setShowPrompt((v) => !v)}
        aria-expanded={showPrompt}
        className="tap-target mt-6 flex w-full items-center justify-between border-t border-hairline pt-4 text-left"
      >
        <span className="type-label-xs text-ink-4">
          {showPrompt ? 'Hide the full brief' : 'Read the full brief'}
        </span>
        <span className="font-mono text-[11px] text-ink-4">{showPrompt ? '−' : '+'}</span>
      </button>

      {showPrompt && (
        <pre className="scrollbar-thin mt-3 max-h-[42vh] overflow-auto whitespace-pre-wrap break-words border border-hairline bg-surface px-4 py-4 font-mono text-[12px] leading-relaxed text-ink-2">
          {brief.prompt}
        </pre>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || !canBuild}
        className="tap-target mt-8 w-full bg-signal px-6 py-5 text-lg font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Starting the build…' : 'Build it'}
      </button>
      {!canBuild && (
        <p className="mt-3 text-center text-[13px] text-ink-4">
          You need at least two players and one idea on the board.
        </p>
      )}
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="tap-target mt-3 w-full py-3 text-center font-mono text-[11px] tracking-[.14em] text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40"
      >
        ← BACK TO THE IDEAS
      </button>
    </div>
  );
}
