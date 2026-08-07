'use client';

import { BUILD_PHASES, deriveBuildStatus, formatElapsed } from '@/lib/build-status';
import type { SseEvent } from '@/lib/types';
import { useEffect, useMemo, useState } from 'react';

/**
 * Live build status shown while a game generates — turns the dead "Building…"
 * spinner into real feedback: the current step, an elapsed timer, and a
 * Design → Build → Test → Ready phase tracker.
 *
 * Identity board 1c: building is the amber LIVE state — an amber-ruled banner
 * with a mono `BUILD · 1:47` readout, a 2px amber progress rule, and a mono
 * phase row (done = lime ✓, active = amber ▸, todo = faint).
 *
 * `full` (default) centers in the empty preview for a FIRST build; `compact`
 * renders a slim top banner overlaid on the still-running game during an
 * ITERATION, so the user keeps playing the current version while the next builds.
 */
export function BuildStatus({
  events,
  isBuilding,
  compact = false,
}: {
  events: SseEvent[];
  isBuilding: boolean;
  compact?: boolean;
}) {
  const status = useMemo(() => deriveBuildStatus(events), [events]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isBuilding) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isBuilding]);

  const elapsed = status.startedAt ? now - status.startedAt : 0;
  const pct = (status.phaseIndex / (BUILD_PHASES.length - 1)) * 100;

  const phaseRow = (
    <div className="flex gap-5 font-mono text-[10px] tracking-[.16em]">
      {BUILD_PHASES.map((phase, i) => {
        const state = i < status.phaseIndex ? 'done' : i === status.phaseIndex ? 'active' : 'todo';
        return (
          <span
            key={phase}
            className={
              state === 'done' ? 'text-pass' : state === 'active' ? 'text-live' : 'text-ink-4'
            }
          >
            {state === 'done' ? '✓ ' : state === 'active' ? '▸ ' : ''}
            {phase.toUpperCase()}
          </span>
        );
      })}
    </div>
  );

  if (compact) {
    return (
      <div className="absolute inset-x-0 top-0 z-20 border-b border-live bg-ground/95 px-3.5 py-2.5 backdrop-blur">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-[13px] text-ink">{status.currentStep}</span>
            <span className="flex-shrink-0 font-mono text-[11px] uppercase tabular-nums tracking-[.14em] text-live">
              BUILD · {formatElapsed(elapsed)}
            </span>
          </div>
          <div className="h-0.5 bg-hairline">
            <div
              className="h-0.5 bg-live transition-all duration-700 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          {phaseRow}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm px-6 text-center">
      <div className="mx-auto mb-6 flex justify-center">
        <Spinner />
      </div>

      <p className="text-sm font-semibold text-ink">Building your game</p>

      <p className="mx-auto mt-1.5 min-h-[2.5em] max-w-xs text-xs leading-relaxed text-ink-3">
        {status.currentStep}
      </p>

      <p className="mt-1 font-mono text-[11px] tabular-nums tracking-[.1em] text-ink-4">
        {formatElapsed(elapsed)} ELAPSED
      </p>

      {/* Phase tracker */}
      <div className="mt-6 flex flex-col items-center gap-2.5">
        <div className="h-0.5 w-full bg-hairline">
          <div
            className="h-0.5 bg-live transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        {phaseRow}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="relative inline-flex h-14 w-14 items-center justify-center border-[1.5px] border-signal text-[22px] font-extrabold text-ink">
      0
      <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-live" />
    </span>
  );
}
