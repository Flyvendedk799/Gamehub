'use client';

import { formatElapsed } from '@/lib/build-status';
import { buildRenderItems } from '@/lib/chat-render';
import { EDIT_TOOL, shouldOfferFix, writtenPaths } from '@/lib/event-normalize';
import type { SseEvent } from '@/lib/types';
import { useEffect, useMemo, useRef, useState } from 'react';

interface ChatPanelProps {
  events: SseEvent[];
  onSend: (prompt: string) => void;
  isStreaming: boolean;
  /** When set, a transient SSE disconnect is being retried (#10). */
  reconnecting?: boolean;
  /**
   * Phase 2.3 — one-click "Fix this error". Called with the prior error string
   * so the builder can start a new run whose prompt includes it. Only wired for
   * genuine `run_error` events, never the transport "Lost connection" case.
   */
  onFixError?: (error: string) => void;
  /**
   * Phase 2.5 — "Resume" a paused long-run. Re-fires generateGame; the server
   * auto-applies the stored continuation.
   */
  onResume?: () => void;
}

export function ChatPanel({
  events,
  onSend,
  isStreaming,
  reconnecting = false,
  onFixError,
  onResume,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: events is the intended trigger — the effect must re-run on each new event to scroll to the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setInput('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSend();
    }
  }

  const renderItems = useMemo(() => buildRenderItems(events), [events]);

  // Elapsed build timer for the "Running" indicator. Anchored to the first event's
  // timestamp so a mid-build reload shows the true elapsed, not 0.
  const startedAt = useMemo(() => {
    for (const e of events) {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t)) return t;
    }
    return null;
  }, [events]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  // Phase 2.6 — "Changed N files" per iteration. Map each terminal event's
  // render key to the file paths written since the previous terminal event, so
  // the completion row can list exactly that iteration's changes.
  const filesByTerminal = useMemo(() => computeFilesByTerminal(events), [events]);

  return (
    <div className="flex flex-col h-full bg-chrome border-r border-hairline">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-2.5 md:py-3 border-b border-hairline flex items-center justify-between gap-2">
        <span className="type-label text-ink">Build log</span>
        {reconnecting ? (
          <output className="flex items-center gap-1.5 font-mono text-[11px] tracking-[.12em] text-live">
            <PulseIcon />
            RECONNECTING…
          </output>
        ) : isStreaming ? (
          <output className="flex items-center gap-1.5 font-mono text-[11px] tracking-[.12em] text-live">
            <PulseIcon />
            RUNNING
            {startedAt !== null && (
              <span className="tabular-nums text-ink-4">· {formatElapsed(nowMs - startedAt)}</span>
            )}
          </output>
        ) : null}
      </div>

      {/* Event stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 space-y-3"
      >
        {events.length === 0 && (
          <div className="flex items-center justify-center h-full text-ink-4 text-sm">
            Describe a change to start your first build.
          </div>
        )}
        {renderItems.map((item, idx) =>
          item.kind === 'text' ? (
            <div key={item.key} className="py-1">
              <div className="type-label-xs mb-1.5 text-signal">Agent</div>
              <div className="border-l-2 border-signal pl-3.5 text-sm leading-relaxed text-ink-2 whitespace-pre-wrap">
                {item.text}
              </div>
            </div>
          ) : (
            <EventRow
              key={item.key}
              event={item.event}
              changedFiles={filesByTerminal.get(item.key)}
              {...(shouldOfferFix(item.event) && onFixError
                ? { onFixError, isLatest: idx === renderItems.length - 1 }
                : {})}
              {...(item.event.type === 'run_paused' && onResume
                ? { onResume, isLatest: idx === renderItems.length - 1 }
                : {})}
              {...(item.event.type === 'run_paused' && item.event.question
                ? { onAnswer: onSend, isLatest: idx === renderItems.length - 1 }
                : {})}
            />
          ),
        )}
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-hairline bg-ground p-3 md:p-4">
        <div className="flex gap-2 md:gap-3 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Building…' : 'Ask for a change…'}
            disabled={isStreaming}
            rows={2}
            className="
              flex-1 bg-surface border border-hairline
              px-3.5 py-2.5 text-sm text-ink placeholder-ink-4
              resize-none outline-none
              focus:border-signal transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="
              flex-shrink-0 px-3 md:px-4 py-2 md:py-2.5 min-h-11 md:min-h-0
              bg-signal hover:bg-signal-bright
              text-chrome text-sm font-bold
              transition-colors duration-150
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          >
            Send
          </button>
        </div>
        <div className="mt-2 hidden items-center justify-between font-mono text-[10px] tracking-[.1em] text-ink-4 sm:flex">
          <span>⌘ ENTER TO SEND</span>
          {isStreaming && <span className="text-live">STREAMING</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Per-iteration "Changed N files" mapping (Phase 2.6) ──────────────────────
//
// Keyed by the render key `buildRenderItems` assigns to each event (`ev-${i}`),
// so the completion row can look up exactly the files written in its iteration.

const TERMINAL_TYPES = new Set(['run_complete', 'run_error', 'run_paused']);

function computeFilesByTerminal(events: SseEvent[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let segmentStart = 0;
  events.forEach((event, i) => {
    if (TERMINAL_TYPES.has(event.type)) {
      const segment = events.slice(segmentStart, i + 1);
      const paths = writtenPaths(segment);
      if (paths.length > 0) result.set(`ev-${i}`, paths);
      segmentStart = i + 1;
    }
  });
  return result;
}

// ─── Individual event row ─────────────────────────────────────────────────────

function EventRow({
  event,
  changedFiles,
  onFixError,
  onResume,
  onAnswer,
  isLatest = false,
}: {
  event: SseEvent;
  changedFiles?: string[];
  onFixError?: (error: string) => void;
  onResume?: () => void;
  /** WS-D — submit an answer to an ask_user question (resumes the run). */
  onAnswer?: (text: string) => void;
  isLatest?: boolean;
}) {
  switch (event.type) {
    case 'agent_start':
      return <StatusChip label="Agent started" color="signal" />;

    // Per-turn markers are agent-loop internals (and the agent emits them with
    // no turnIndex → "Turn NaN"). They wrap every single tool call, drowning the
    // real build steps in noise — suppress them entirely.
    case 'turn_start':
    case 'turn_end':
      return null;

    case 'agent_end':
      return <StatusChip label="Agent finished" color="pass" />;

    case 'run_complete':
      return (
        <div className="space-y-1.5">
          <StatusChip label="Build complete — game ready" color="pass" />
          {changedFiles && changedFiles.length > 0 && <ChangedFilesSummary paths={changedFiles} />}
        </div>
      );

    case 'run_error':
      return (
        <div className="space-y-2">
          <div className="flex items-start gap-2 border border-fail bg-fail/5 px-3 py-2 font-mono text-xs text-fail">
            <span className="flex-shrink-0 opacity-60">ERR</span>
            <span className="break-all">{event.error}</span>
          </div>
          {onFixError && isLatest && (
            <button
              type="button"
              onClick={() => onFixError(event.error)}
              className="inline-flex items-center gap-1.5 bg-fail px-4 py-2.5 text-sm font-bold text-chrome transition-colors hover:opacity-90 md:px-3 md:py-1.5 md:text-xs"
            >
              ↻ Fix it
            </button>
          )}
        </div>
      );

    case 'run_paused':
      // WS-D — an ask_user pause carries a question: show it with an answer box.
      // A plain checkpoint pause keeps the Resume button.
      if (event.question) {
        return (
          <AskQuestionCard
            question={event.question}
            {...(onAnswer && isLatest ? { onAnswer } : {})}
          />
        );
      }
      return (
        <div className="space-y-2">
          <StatusChip label="Paused — long build checkpointed" color="signal" />
          {onResume && isLatest && (
            <button
              type="button"
              onClick={() => onResume()}
              className="inline-flex items-center gap-1.5 border border-signal px-4 py-2.5 text-sm font-semibold text-signal transition-colors hover:bg-raised md:px-3 md:py-1.5 md:text-xs"
            >
              ▶ Resume build
            </button>
          )}
        </div>
      );

    case 'game_spec':
      return <GameSpecCard event={event} />;

    case 'plan':
      return <PlanCard event={event} />;

    case 'user_message':
      return (
        <div className="py-1">
          <div className="type-label-xs mb-1.5 text-ink-4">You</div>
          <div className="border-l-2 border-edge pl-3.5 text-sm leading-relaxed text-ink whitespace-pre-wrap">
            {event.content}
          </div>
        </div>
      );

    case 'message_update':
      return (
        <div className="border-l-2 border-signal pl-3.5 py-1 text-sm leading-relaxed text-ink-2 whitespace-pre-wrap">
          {event.content}
        </div>
      );

    case 'text_delta':
      // Coalesced into a single bubble upstream by buildRenderItems (#51);
      // a standalone delta should still render rather than vanish.
      return (
        <span className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap">
          {event.delta}
        </span>
      );

    case 'assistant_text':
      // Usually folded into the coalesced narration block by buildRenderItems;
      // render standalone snapshots too so the AI's prose never vanishes.
      return (
        <p className="border-l-2 border-signal pl-3.5 py-0.5 text-sm leading-relaxed text-ink-2 whitespace-pre-wrap">
          {event.text}
        </p>
      );

    case 'thinking_delta':
      return <span className="text-xs italic leading-relaxed text-ink-4">{event.delta}</span>;

    case 'tool_use':
      return <ToolChip label={event.label ?? event.toolName} status={event.status} />;

    case 'tool_result':
      // Successful edit-tool calls (writes + reads) are folded into the start
      // chip ("writing index.html") + the per-iteration "Changed N files"
      // summary, so they don't also emit a redundant — and, since the end frame
      // carries no args, mislabeled — result chip. Failures still surface.
      if (
        event.success &&
        (event.path || event.toolName === EDIT_TOOL || event.toolName === 'set_todos')
      ) {
        return null; // set_todos shows as the plan card; edits fold into the summary
      }
      return (
        <ToolChip
          label={event.label ?? event.toolName}
          status={event.success ? 'done' : 'error'}
          isResult
        />
      );

    default:
      return null;
  }
}

// ─── Game spec card (Phase 2.2) ───────────────────────────────────────────────

function GameSpecCard({
  event,
}: {
  event: Extract<SseEvent, { type: 'game_spec' }>;
}) {
  return (
    <div className="space-y-1.5 border border-hairline bg-surface px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="type-label-xs text-signal">
          {event.amend ? "Updating what I'm building" : "Here's what I'm building"}
        </span>
      </div>
      {event.genre && <p className="text-sm font-semibold capitalize text-ink">{event.genre}</p>}
      {(event.winCondition || event.loseCondition) && (
        <dl className="space-y-1 text-xs">
          {event.winCondition && (
            <div className="flex gap-2">
              <dt className="flex-shrink-0 font-mono text-pass">win</dt>
              <dd className="text-ink-3">{event.winCondition}</dd>
            </div>
          )}
          {event.loseCondition && (
            <div className="flex gap-2">
              <dt className="flex-shrink-0 font-mono text-fail">lose</dt>
              <dd className="text-ink-3">{event.loseCondition}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

// ─── "Changed N files" summary (Phase 2.6) ────────────────────────────────────

function ChangedFilesSummary({ paths }: { paths: string[] }) {
  return (
    <div className="border border-hairline bg-surface">
      <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
        <span className="type-label-xs tracking-[.14em] text-ink-3">
          Changed {paths.length} {paths.length === 1 ? 'file' : 'files'}
        </span>
        <span className="font-mono text-[10px] text-pass">+{paths.length}</span>
      </div>
      <ul className="py-1.5">
        {paths.map((p) => (
          <li
            key={p}
            className="flex items-center gap-2.5 break-all px-3 py-1 font-mono text-xs text-ink-3"
          >
            <span className="text-signal">write</span>
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Plan checklist (set_todos) ───────────────────────────────────────────────

function PlanCard({ event }: { event: Extract<SseEvent, { type: 'plan' }> }) {
  const done = event.items.filter((i) => i.checked).length;
  return (
    <div className="space-y-2 border border-hairline bg-surface px-3.5 py-3">
      <div className="flex items-center justify-between">
        <span className="type-label-xs text-signal">Plan</span>
        <span className="font-mono text-[10px] text-ink-4">
          {done}/{event.items.length}
        </span>
      </div>
      <ul className="space-y-1">
        {event.items.map((item, i) => (
          <li
            key={`${i}-${item.text}`}
            className={`flex items-start gap-2 text-sm leading-relaxed ${
              item.checked ? 'text-ink-4 line-through' : 'text-ink-2'
            }`}
          >
            <span className={`mt-0.5 flex-shrink-0 ${item.checked ? 'text-pass' : 'text-ink-4'}`}>
              {item.checked ? '✓' : '○'}
            </span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Ask-user question card (WS-D) ────────────────────────────────────────────

function AskQuestionCard({
  question,
  onAnswer,
}: {
  question: string;
  onAnswer?: (text: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const submit = () => {
    const a = answer.trim();
    if (!a || !onAnswer) return;
    onAnswer(`In answer to your question "${question}": ${a}`);
    setAnswer('');
  };
  return (
    <div className="space-y-2 border border-live bg-surface px-3.5 py-3">
      <span className="type-label-xs text-live">Question for you</span>
      <p className="text-sm leading-relaxed text-ink">{question}</p>
      {onAnswer && (
        <div className="flex items-end gap-2">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="Type your answer…"
            rows={2}
            className="flex-1 resize-none border border-hairline bg-ground px-3 py-2 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-live"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!answer.trim()}
            className="min-h-11 flex-shrink-0 bg-live px-3 py-2 text-sm font-bold text-chrome transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Tool call chip ───────────────────────────────────────────────────────────

function ToolChip({
  label,
  status,
  isResult = false,
}: {
  label: string;
  status: 'start' | 'done' | 'error';
  isResult?: boolean;
}) {
  const verb = status === 'done' ? 'pass' : status === 'error' ? 'fail' : 'run';

  const verbClass =
    status === 'done' ? 'text-pass' : status === 'error' ? 'text-fail' : 'text-live';

  return (
    <div
      className={`flex items-center gap-2.5 px-1 py-0.5 font-mono text-xs text-ink-3 ${
        status === 'start' ? 'bg-raised' : ''
      } ${isResult ? 'opacity-70' : ''}`}
    >
      <span className={verbClass}>{verb}</span>
      <span className="break-all">{label}</span>
    </div>
  );
}

// ─── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({
  label,
  color,
  dim = false,
}: {
  label: string;
  color: 'signal' | 'pass';
  dim?: boolean;
}) {
  const colorMap = {
    signal: 'text-signal',
    pass: 'text-pass',
  };

  return (
    <div
      className={`flex items-center gap-2 font-mono text-xs ${colorMap[color]} ${dim ? 'opacity-40' : ''}`}
    >
      <span className="text-[8px]">◆</span>
      <span>{label}</span>
    </div>
  );
}

// ─── Pulse dot ───────────────────────────────────────────────────────────────

function PulseIcon({ color = '#ffb04d' }: { color?: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex rounded-full h-1.5 w-1.5"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}
