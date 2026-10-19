'use client';

import React from 'react';

export type GenerationPhase =
  | 'analyzing'
  | 'planning'
  | 'writing_code'
  | 'verifying'
  | 'repairing'
  | 'bundling'
  | 'completed'
  | 'failed';

export interface GenerationProgressStepperProps {
  currentPhase: GenerationPhase;
  reflexionTurn?: number;
  maxReflexionTurns?: number;
  failedPhase?: GenerationPhase;
  errorMessage?: string;
  className?: string;
}

interface PhaseDefinition {
  id: GenerationPhase;
  label: string;
  shortLabel: string;
}

const PHASES: PhaseDefinition[] = [
  { id: 'analyzing', label: 'Analyzing', shortLabel: 'Analyze' },
  { id: 'planning', label: 'Planning', shortLabel: 'Plan' },
  { id: 'writing_code', label: 'Writing Code', shortLabel: 'Code' },
  { id: 'verifying', label: 'Verifying', shortLabel: 'Verify' },
  { id: 'repairing', label: 'Repairing', shortLabel: 'Repair' },
  { id: 'bundling', label: 'Bundling', shortLabel: 'Bundle' },
  { id: 'completed', label: 'Completed', shortLabel: 'Done' },
];

const PHASE_ORDER: GenerationPhase[] = [
  'analyzing',
  'planning',
  'writing_code',
  'verifying',
  'repairing',
  'bundling',
  'completed',
];

export function GenerationProgressStepper({
  currentPhase,
  reflexionTurn = 1,
  maxReflexionTurns = 2,
  failedPhase,
  errorMessage,
  className = '',
}: GenerationProgressStepperProps) {
  const isFailed = currentPhase === 'failed';
  const effectiveCurrentIndex = isFailed
    ? failedPhase
      ? PHASE_ORDER.indexOf(failedPhase)
      : PHASE_ORDER.indexOf('verifying')
    : PHASE_ORDER.indexOf(currentPhase);

  const activeAnnouncement = isFailed
    ? `Game generation failed${errorMessage ? `: ${errorMessage}` : ''}`
    : currentPhase === 'repairing'
      ? `Repairing generated code with Reflexion Turn ${reflexionTurn} of ${maxReflexionTurns}`
      : `Game generation phase: ${currentPhase.replace('_', ' ')}`;

  return (
    <nav
      aria-label="Game Generation Progress"
      className={`w-full bg-chrome/90 border border-hairline rounded p-3 backdrop-blur ${className}`}
    >
      {/* Screen reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {activeAnnouncement}
      </div>

      <ol
        // biome-ignore lint/a11y/noRedundantRoles: role list needed
        // biome-ignore lint/a11y/useSemanticElements: role list needed
        role="list"
        className="flex items-center justify-between gap-1 sm:gap-2 overflow-x-auto py-1"
      >
        {PHASES.map((phase, index) => {
          const isPhaseActive = !isFailed && currentPhase === phase.id;
          const isPhaseCompleted = !isFailed && effectiveCurrentIndex > index;
          const isPhaseFailed =
            isFailed &&
            (failedPhase === phase.id || (!failedPhase && index === effectiveCurrentIndex));
          const isPhasePending = !isPhaseActive && !isPhaseCompleted && !isPhaseFailed;
          const isRepairing = isPhaseActive && phase.id === 'repairing';

          let nodeClasses = 'border transition-all duration-300 ';
          if (isRepairing) {
            // High-visibility Amber Reflexion Pulse when in 'repairing' state
            nodeClasses += 'animate-pulse text-amber-400 bg-amber-950/40 border-amber-500/50';
          } else if (isPhaseActive) {
            nodeClasses +=
              'text-signal bg-signal/10 border-signal/60 shadow-[0_0_10px_rgba(70,230,240,0.25)]';
          } else if (isPhaseCompleted) {
            nodeClasses += 'text-emerald-400 bg-emerald-950/30 border-emerald-500/40';
          } else if (isPhaseFailed) {
            nodeClasses += 'text-rose-400 bg-rose-950/40 border-rose-500/50';
          } else {
            nodeClasses += 'text-ink-4 bg-surface/40 border-hairline';
          }

          return (
            <li
              key={phase.id}
              aria-current={isPhaseActive ? 'step' : undefined}
              className="flex-1 min-w-[70px] sm:min-w-[90px] flex flex-col items-center group"
            >
              <div
                className={`w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs font-mono font-medium ${nodeClasses}`}
              >
                {/* Step indicator symbol */}
                <span className="flex-shrink-0 text-[10px]">
                  {isPhaseCompleted && '✓'}
                  {isPhaseFailed && '✕'}
                  {isRepairing && '⚙'}
                  {isPhaseActive && !isRepairing && '▸'}
                  {isPhasePending && '○'}
                </span>

                <span className="truncate">{phase.label}</span>
              </div>

              {/* Reflexion retry badge indicator [Reflexion Turn N/2] */}
              {isRepairing && (
                <div
                  data-testid="reflexion-badge"
                  className="mt-1 font-mono text-[10px] tracking-wide uppercase px-1.5 py-0.5 rounded text-amber-300 bg-amber-900/50 border border-amber-500/40 shadow-sm"
                >
                  {`[Reflexion Turn ${reflexionTurn}/${maxReflexionTurns}]`}
                </div>
              )}

              {isPhaseFailed && errorMessage && (
                <div className="mt-1 font-mono text-[10px] text-rose-400 truncate max-w-full">
                  [Error]
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
