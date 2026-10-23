'use client';

import { formatElapsed } from '@/lib/build-status';
import { isTransportError } from '@/lib/event-normalize';
import {
  type AgentTurn,
  type TurnStep,
  currentLabel,
  fixIssuesPrompt,
  hasOpenIssues,
  workedFor,
} from '@/lib/run-turns';
import { useState } from 'react';
import { Markdownish } from './Markdownish';
import { Check, Chevron, Cross, Spinner } from './icons';

export interface AgentTurnViewProps {
  turn: AgentTurn;
  /** Wall clock, ticking once a second while a run is live, for the working timer. */
  nowMs: number;
  /** The newest turn: only it offers actions (retry, resume, answer, fix). */
  isLatest: boolean;
  onFixIssues?: ((prompt: string) => void) | undefined;
  onRetry?: ((error: string) => void) | undefined;
  onResume?: (() => void) | undefined;
  onAnswer?: ((text: string) => void) | undefined;
}

/** How many steps the live card shows; earlier ones fold into "+N earlier". */
const VISIBLE_STEPS = 5;

export function AgentTurnView(props: AgentTurnViewProps) {
  const { turn } = props;
  switch (turn.status) {
    case 'working':
      return <WorkingCard turn={turn} nowMs={props.nowMs} />;
    case 'error':
      return <ErrorCard turn={turn} isLatest={props.isLatest} onRetry={props.onRetry} />;
    case 'paused':
      return (
        <PausedCard
          turn={turn}
          isLatest={props.isLatest}
          onResume={props.onResume}
          onAnswer={props.onAnswer}
        />
      );
    default:
      return <DoneReply {...props} />;
  }
}

// ─── Working ─────────────────────────────────────────────────────────────────

function WorkingCard({ turn, nowMs }: { turn: AgentTurn; nowMs: number }) {
  const label = currentLabel(turn);
  const elapsed =
    turn.startedAt === null ? null : formatElapsed(Math.max(0, nowMs - turn.startedAt));
  const hidden = Math.max(0, turn.steps.length - VISIBLE_STEPS);
  const visible = turn.steps.slice(hidden);
  return (
    <div
      className="rounded-xl border border-hairline bg-surface px-3.5 py-3"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-2.5">
        <Spinner size={15} className="flex-shrink-0 text-live" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{label}…</p>
        {elapsed !== null && (
          <span className="flex-shrink-0 font-mono text-[11px] tabular-nums text-ink-4">
            {elapsed}
          </span>
        )}
      </div>

      {turn.steps.length > 1 && (
        <ul className="mt-3 space-y-1.5 border-t border-hairline pt-3">
          {hidden > 0 && <li className="pl-[26px] text-xs text-ink-4">+{hidden} earlier</li>}
          {visible.map((step, i) => (
            // A step label can repeat across repair rounds; position keeps rows distinct.
            <StepRow key={`${hidden + i}-${step.label}`} step={step} />
          ))}
        </ul>
      )}

      {turn.previewUpdated && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-pass/10 px-2.5 py-1.5 text-xs text-pass">
          <Check size={12} className="flex-shrink-0" />
          Your change is already in the preview. I'm still testing it.
        </p>
      )}
    </div>
  );
}

function StepRow({ step }: { step: TurnStep }) {
  return (
    <li className="flex items-center gap-2.5 text-xs leading-relaxed">
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
        {step.state === 'active' ? (
          <Spinner size={12} className="text-live" />
        ) : step.state === 'failed' ? (
          <Cross size={12} className="text-fail" />
        ) : (
          <Check size={12} className="text-pass" />
        )}
      </span>
      <span className={step.state === 'active' ? 'text-ink' : 'text-ink-3'}>{step.label}</span>
      {step.count > 1 && (
        <span className="font-mono text-[10px] tabular-nums text-ink-4">×{step.count}</span>
      )}
    </li>
  );
}

// ─── Done ────────────────────────────────────────────────────────────────────

type Panel = 'steps' | 'files' | 'issues';

function DoneReply({ turn, isLatest, onFixIssues }: AgentTurnViewProps) {
  const [open, setOpen] = useState<Panel | null>(null);
  const toggle = (panel: Panel) => setOpen((current) => (current === panel ? null : panel));
  const worked = workedFor(turn);
  const issues = turn.quality?.issues ?? [];
  const openIssues = hasOpenIssues(turn);
  const verified = turn.quality?.status === 'verified';

  return (
    <div className="space-y-3">
      {turn.summary !== null ? (
        <Markdownish text={turn.summary} className="text-ink" />
      ) : (
        <p className="text-sm text-ink-2">Your new version is ready.</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-ink-4">
        {turn.steps.length > 0 && (
          <Toggle open={open === 'steps'} onClick={() => toggle('steps')}>
            {worked !== null ? `Worked for ${worked}` : 'What I did'}
          </Toggle>
        )}
        {turn.files.length > 0 && (
          <Toggle open={open === 'files'} onClick={() => toggle('files')}>
            {turn.files.length} {turn.files.length === 1 ? 'file' : 'files'} changed
          </Toggle>
        )}
        {verified && (
          <span className="inline-flex items-center gap-1.5 text-pass">
            <Check size={12} />
            Checks passed
          </span>
        )}
      </div>

      {open === 'steps' && <StepsPanel turn={turn} />}
      {open === 'files' && <FilesPanel files={turn.files} />}

      {openIssues && (
        <div className="space-y-2 rounded-lg border border-live/30 bg-live/5 px-3 py-2.5">
          <p className="text-xs font-medium text-ink">
            The game runs, but one of my automated checks did not pass.
          </p>
          <ul className="space-y-1 text-xs text-ink-3">
            {issues.slice(0, 3).map((issue) => (
              <li key={issue} className="flex gap-2">
                <span
                  aria-hidden
                  className="mt-[0.5em] h-1 w-1 flex-shrink-0 rounded-full bg-live"
                />
                <span className="min-w-0 flex-1 break-words">{issue}</span>
              </li>
            ))}
          </ul>
          {isLatest && onFixIssues && (
            <button
              type="button"
              onClick={() => onFixIssues(fixIssuesPrompt(issues))}
              className="rounded-md border border-live/50 px-2.5 py-1 text-xs font-medium text-live transition-colors hover:bg-live/10"
            >
              Ask me to fix it
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({
  open,
  onClick,
  children,
}: { open: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="inline-flex items-center gap-1 rounded text-ink-4 transition-colors hover:text-ink-2"
    >
      <Chevron open={open} />
      {children}
    </button>
  );
}

function StepsPanel({ turn }: { turn: AgentTurn }) {
  return (
    <div className="space-y-2.5 rounded-lg border border-hairline bg-surface/60 px-3 py-2.5">
      <ul className="space-y-1.5">
        {turn.steps.map((step, i) => (
          <StepRow key={`${i}-${step.label}`} step={step} />
        ))}
      </ul>
      {turn.notes.length > 0 && (
        <div className="space-y-1 border-t border-hairline pt-2.5">
          <p className="type-label-xs text-ink-4">My notes</p>
          {turn.notes.slice(-8).map((note, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only
            <p key={i} className="text-xs leading-relaxed text-ink-3">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function FilesPanel({ files }: { files: string[] }) {
  return (
    <ul className="space-y-1 rounded-lg border border-hairline bg-surface/60 px-3 py-2.5">
      {files.map((file) => (
        <li key={file} className="break-all font-mono text-xs text-ink-3">
          {file}
        </li>
      ))}
    </ul>
  );
}

// ─── Error ───────────────────────────────────────────────────────────────────

function ErrorCard({
  turn,
  isLatest,
  onRetry,
}: { turn: AgentTurn; isLatest: boolean; onRetry?: ((error: string) => void) | undefined }) {
  const [showDetail, setShowDetail] = useState(false);
  const error = turn.error ?? 'This run failed.';
  const lostConnection = isTransportError(error);
  return (
    <div className="space-y-2.5 rounded-xl border border-fail/30 bg-fail/5 px-3.5 py-3">
      <p className="text-sm text-ink">
        {lostConnection
          ? 'I lost the connection while working on this.'
          : 'Something went wrong while working on this.'}
      </p>
      <button
        type="button"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
        className="inline-flex items-center gap-1 text-xs text-ink-4 transition-colors hover:text-ink-2"
      >
        <Chevron open={showDetail} />
        Details
      </button>
      {showDetail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ground px-2.5 py-2 font-mono text-[11px] text-fail">
          {error}
        </pre>
      )}
      {isLatest && onRetry && !lostConnection && (
        <button
          type="button"
          onClick={() => onRetry(error)}
          className="rounded-md bg-fail px-3 py-1.5 text-xs font-semibold text-chrome transition-opacity hover:opacity-90"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// ─── Paused / question ───────────────────────────────────────────────────────

function PausedCard({
  turn,
  isLatest,
  onResume,
  onAnswer,
}: {
  turn: AgentTurn;
  isLatest: boolean;
  onResume?: (() => void) | undefined;
  onAnswer?: ((text: string) => void) | undefined;
}) {
  const [answer, setAnswer] = useState('');
  if (turn.question !== null) {
    const question = turn.question;
    const submit = () => {
      const text = answer.trim();
      if (!text || !onAnswer) return;
      onAnswer(`In answer to your question "${question}": ${text}`);
      setAnswer('');
    };
    return (
      <div className="space-y-2.5 rounded-xl border border-live/40 bg-surface px-3.5 py-3">
        <p className="type-label-xs text-live">A quick question</p>
        <p className="text-sm leading-relaxed text-ink">{question}</p>
        {isLatest && onAnswer && (
          <div className="flex items-end gap-2">
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Your answer…"
              rows={2}
              className="flex-1 resize-none rounded-lg border border-hairline bg-ground px-3 py-2 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-live"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!answer.trim()}
              className="min-h-10 rounded-lg bg-live px-3.5 text-sm font-semibold text-chrome transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2.5 rounded-xl border border-hairline bg-surface px-3.5 py-3">
      <p className="text-sm text-ink">
        I paused so this stays responsive. Everything so far is saved.
      </p>
      {isLatest && onResume && (
        <button
          type="button"
          onClick={() => onResume()}
          className="rounded-md border border-signal px-3 py-1.5 text-xs font-semibold text-signal transition-colors hover:bg-raised"
        >
          Keep going
        </button>
      )}
    </div>
  );
}
