'use client';

import { BUILD_PHASES, deriveBuildStatus, formatElapsed } from '@/lib/build-status';
import type { SseEvent } from '@/lib/types';
import { useEffect, useMemo, useState } from 'react';

/**
 * Live build status shown while a game generates — turns the dead "Building…"
 * spinner into real feedback: the current step, an elapsed timer, and a
 * Design → Build → Test → Ready phase tracker.
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

  if (compact) {
    return (
      <div className="absolute inset-x-0 top-0 z-20 m-2 rounded-xl border border-[#6366f1]/30 bg-[#0d0d16]/95 px-3 py-2 shadow-lg backdrop-blur">
        <div className="flex items-center gap-2.5">
          <Spinner small />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-[#c7d2fe]">
                {status.currentStep}
              </span>
              <span className="flex-shrink-0 font-mono text-[10px] uppercase tabular-nums tracking-wider text-[#818cf8]">
                {status.phase} · {formatElapsed(elapsed)}
              </span>
            </div>
            <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-[#1f1f2e]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#6366f1] to-[#818cf8] transition-all duration-700 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm px-6 text-center">
      <div className="mx-auto mb-5">
        <Spinner />
      </div>

      <p className="text-sm font-medium text-[#f4f4f5]">Building your game</p>

      <p className="mx-auto mt-1.5 min-h-[2.5em] max-w-xs text-xs leading-relaxed text-[#a1a1aa]">
        {status.currentStep}
      </p>

      <p className="mt-1 font-mono text-[11px] tabular-nums text-[#52525b]">
        {formatElapsed(elapsed)} elapsed
      </p>

      {/* Phase tracker */}
      <div className="mt-6">
        <div className="flex items-start justify-between">
          {BUILD_PHASES.map((phase, i) => {
            const state =
              i < status.phaseIndex ? 'done' : i === status.phaseIndex ? 'active' : 'todo';
            return (
              <div key={phase} className="flex flex-1 flex-col items-center gap-1.5">
                <span
                  className={`relative flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                    state === 'done'
                      ? 'bg-[#22c55e]/15 text-[#22c55e]'
                      : state === 'active'
                        ? 'bg-[#6366f1] text-white'
                        : 'border border-[#27272a] text-[#3f3f46]'
                  }`}
                >
                  {state === 'active' && (
                    <span className="absolute inset-0 animate-ping rounded-full bg-[#6366f1] opacity-60" />
                  )}
                  <span className="relative">{state === 'done' ? '✓' : i + 1}</span>
                </span>
                <span
                  className={`font-mono text-[9px] uppercase tracking-wider ${
                    state === 'todo' ? 'text-[#3f3f46]' : 'text-[#a1a1aa]'
                  }`}
                >
                  {phase}
                </span>
              </div>
            );
          })}
        </div>
        <div className="relative mt-2 h-0.5 overflow-hidden rounded-full bg-[#1f1f1f]">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#6366f1] to-[#818cf8] transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? 'h-4 w-4' : 'h-11 w-11';
  return (
    <span className={`relative inline-block ${size}`}>
      <span className="absolute inset-0 rounded-full border-2 border-[#6366f1]/15" />
      <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#6366f1]" />
    </span>
  );
}
