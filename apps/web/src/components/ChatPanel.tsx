'use client';

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

  // Phase 2.6 — "Changed N files" per iteration. Map each terminal event's
  // render key to the file paths written since the previous terminal event, so
  // the completion row can list exactly that iteration's changes.
  const filesByTerminal = useMemo(() => computeFilesByTerminal(events), [events]);

  return (
    <div className="flex flex-col h-full bg-[#111111] border-r border-[#222222]">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-2.5 md:py-3 border-b border-[#222222] flex items-center gap-2">
        <span className="text-xs font-mono uppercase tracking-widest text-[#52525b]">
          Build log
        </span>
        {reconnecting ? (
          <output className="flex items-center gap-1.5 text-xs text-[#f59e0b]">
            <PulseIcon color="#f59e0b" />
            Reconnecting…
          </output>
        ) : isStreaming ? (
          <output className="flex items-center gap-1.5 text-xs text-[#6366f1]">
            <PulseIcon />
            Running
          </output>
        ) : null}
      </div>

      {/* Event stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-3 md:py-4 space-y-1"
      >
        {events.length === 0 && (
          <div className="flex items-center justify-center h-full text-[#3f3f46] text-sm">
            Waiting for your first build…
          </div>
        )}
        {renderItems.map((item, idx) =>
          item.kind === 'text' ? (
            <div
              key={item.key}
              className="text-sm text-[#f4f4f5] leading-relaxed whitespace-pre-wrap py-1"
            >
              {item.text}
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
      <div className="flex-shrink-0 border-t border-[#222222] p-3 md:p-4">
        <div className="flex gap-2 md:gap-3 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'Building…' : 'Iterate on your game…'}
            disabled={isStreaming}
            rows={2}
            className="
              flex-1 bg-[#0a0a0a] border border-[#222222] rounded-xl
              px-3 py-2 md:py-2.5 text-sm text-[#f4f4f5] placeholder-[#52525b]
              resize-none outline-none
              focus:border-[#6366f1] transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="
              flex-shrink-0 px-3 md:px-4 py-2 md:py-2.5 min-h-11 md:min-h-0 rounded-xl
              bg-[#6366f1] hover:bg-[#4f46e5] active:bg-[#4338ca]
              text-white text-sm font-medium
              transition-colors duration-150
              disabled:opacity-40 disabled:cursor-not-allowed
            "
          >
            Send
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-[#3f3f46] hidden sm:block">⌘ + Enter to send</p>
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
      return <StatusChip label="Agent started" color="indigo" />;

    // Per-turn markers are agent-loop internals (and the agent emits them with
    // no turnIndex → "Turn NaN"). They wrap every single tool call, drowning the
    // real build steps in noise — suppress them entirely.
    case 'turn_start':
    case 'turn_end':
      return null;

    case 'agent_end':
      return <StatusChip label="Agent finished" color="green" />;

    case 'run_complete':
      return (
        <div className="space-y-1.5">
          <StatusChip label="Build complete — game ready" color="green" />
          {changedFiles && changedFiles.length > 0 && <ChangedFilesSummary paths={changedFiles} />}
        </div>
      );

    case 'run_error':
      return (
        <div className="space-y-2">
          <div className="flex items-start gap-2 font-mono text-xs text-[#ef4444] bg-[#ef4444]/5 border border-[#ef4444]/10 rounded-lg px-3 py-2">
            <span className="opacity-60 flex-shrink-0">ERR</span>
            <span className="break-all">{event.error}</span>
          </div>
          {onFixError && isLatest && (
            <button
              type="button"
              onClick={() => onFixError(event.error)}
              className="
                inline-flex items-center gap-1.5 text-sm px-4 py-2.5 md:text-xs md:px-3 md:py-1.5 rounded-lg
                bg-[#ef4444]/10 hover:bg-[#ef4444]/20
                text-[#f87171] border border-[#ef4444]/20
                transition-colors font-medium
              "
            >
              ↻ Fix this error
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
          <StatusChip label="Paused — long build checkpointed" color="indigo" />
          {onResume && isLatest && (
            <button
              type="button"
              onClick={() => onResume()}
              className="
                inline-flex items-center gap-1.5 text-sm px-4 py-2.5 md:text-xs md:px-3 md:py-1.5 rounded-lg
                bg-[#6366f1]/10 hover:bg-[#6366f1]/20
                text-[#818cf8] border border-[#6366f1]/20
                transition-colors font-medium
              "
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
        <div className="flex justify-end py-1">
          <div className="max-w-[85%] rounded-xl rounded-br-sm bg-[#6366f1]/15 border border-[#6366f1]/25 px-3 py-2 text-sm text-[#e0e7ff] leading-relaxed whitespace-pre-wrap">
            {event.content}
          </div>
        </div>
      );

    case 'message_update':
      return (
        <div className="text-sm text-[#f4f4f5] leading-relaxed py-1 whitespace-pre-wrap">
          {event.content}
        </div>
      );

    case 'text_delta':
      // Coalesced into a single bubble upstream by buildRenderItems (#51);
      // a standalone delta should still render rather than vanish.
      return (
        <span className="text-sm text-[#f4f4f5] leading-relaxed whitespace-pre-wrap">
          {event.delta}
        </span>
      );

    case 'assistant_text':
      // Usually folded into the coalesced narration block by buildRenderItems;
      // render standalone snapshots too so the AI's prose never vanishes.
      return (
        <p className="text-sm text-[#d4d4d8] leading-relaxed py-0.5 whitespace-pre-wrap">
          {event.text}
        </p>
      );

    case 'thinking_delta':
      return <span className="text-xs text-[#52525b] italic leading-relaxed">{event.delta}</span>;

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
    <div className="rounded-xl border border-[#6366f1]/25 bg-[#6366f1]/5 px-3.5 py-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[#818cf8]">
          {event.amend ? "Updating what I'm building" : "Here's what I'm building"}
        </span>
      </div>
      {event.genre && (
        <p className="text-sm text-[#f4f4f5] font-medium capitalize">{event.genre}</p>
      )}
      {(event.winCondition || event.loseCondition) && (
        <dl className="space-y-1 text-xs">
          {event.winCondition && (
            <div className="flex gap-2">
              <dt className="text-[#22c55e] font-mono flex-shrink-0">Win</dt>
              <dd className="text-[#a1a1aa]">{event.winCondition}</dd>
            </div>
          )}
          {event.loseCondition && (
            <div className="flex gap-2">
              <dt className="text-[#ef4444] font-mono flex-shrink-0">Lose</dt>
              <dd className="text-[#a1a1aa]">{event.loseCondition}</dd>
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
    <div className="rounded-lg border border-[#222222] bg-[#0f0f0f] px-3 py-2">
      <p className="text-[10px] font-mono uppercase tracking-widest text-[#52525b] mb-1.5">
        Changed {paths.length} {paths.length === 1 ? 'file' : 'files'}
      </p>
      <ul className="space-y-0.5">
        {paths.map((p) => (
          <li
            key={p}
            className="text-xs font-mono text-[#a1a1aa] break-all flex items-center gap-1.5"
          >
            <span className="text-[#22c55e]">+</span>
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
    <div className="rounded-xl border border-[#6366f1]/25 bg-[#6366f1]/5 px-3.5 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[#818cf8]">Plan</span>
        <span className="text-[10px] font-mono text-[#52525b]">
          {done}/{event.items.length}
        </span>
      </div>
      <ul className="space-y-1">
        {event.items.map((item, i) => (
          <li
            key={`${i}-${item.text}`}
            className={`flex items-start gap-2 text-sm leading-relaxed ${
              item.checked ? 'text-[#52525b] line-through' : 'text-[#e4e4e7]'
            }`}
          >
            <span
              className={`mt-0.5 flex-shrink-0 ${item.checked ? 'text-[#22c55e]' : 'text-[#3f3f46]'}`}
            >
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
    <div className="rounded-xl border border-[#f59e0b]/30 bg-[#f59e0b]/5 px-3.5 py-3 space-y-2">
      <span className="text-[10px] font-mono uppercase tracking-widest text-[#fbbf24]">
        Question for you
      </span>
      <p className="text-sm text-[#f4f4f5] leading-relaxed">{question}</p>
      {onAnswer && (
        <div className="flex gap-2 items-end">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="Type your answer…"
            rows={2}
            className="flex-1 bg-[#0a0a0a] border border-[#222222] rounded-lg px-3 py-2 text-sm text-[#f4f4f5] placeholder-[#52525b] resize-none outline-none focus:border-[#f59e0b] transition-colors"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!answer.trim()}
            className="flex-shrink-0 px-3 py-2 min-h-11 md:min-h-0 rounded-lg bg-[#f59e0b] hover:bg-[#d97706] text-[#1a1a1a] text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
  const icon = status === 'done' ? '✓' : status === 'error' ? '✗' : '●';

  const colorClass =
    status === 'done'
      ? 'text-[#22c55e] border-[#22c55e]/20 bg-[#22c55e]/5'
      : status === 'error'
        ? 'text-[#ef4444] border-[#ef4444]/20 bg-[#ef4444]/5'
        : 'text-[#6366f1] border-[#6366f1]/20 bg-[#6366f1]/5 animate-pulse';

  return (
    <div
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] border rounded-md px-2 py-1 ${colorClass} ${isResult ? 'opacity-70' : ''}`}
    >
      <span>{icon}</span>
      <span>{label}</span>
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
  color: 'indigo' | 'green';
  dim?: boolean;
}) {
  const colorMap = {
    indigo: 'text-[#6366f1]',
    green: 'text-[#22c55e]',
  };

  return (
    <div
      className={`flex items-center gap-2 text-xs font-mono ${colorMap[color]} ${dim ? 'opacity-40' : ''}`}
    >
      <span className="text-[8px]">◆</span>
      <span>{label}</span>
    </div>
  );
}

// ─── Pulse dot ───────────────────────────────────────────────────────────────

function PulseIcon({ color = '#6366f1' }: { color?: string }) {
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
