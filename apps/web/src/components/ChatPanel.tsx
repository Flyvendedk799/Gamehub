'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRenderItems } from '@/lib/chat-render';
import type { SseEvent } from '@/lib/types';

interface ChatPanelProps {
  events: SseEvent[];
  onSend: (prompt: string) => void;
  isStreaming: boolean;
  /** When set, a transient SSE disconnect is being retried (#10). */
  reconnecting?: boolean;
}

export function ChatPanel({ events, onSend, isStreaming, reconnecting = false }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
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

  return (
    <div className="flex flex-col h-full bg-[#111111] border-r border-[#222222]">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-2.5 md:py-3 border-b border-[#222222] flex items-center gap-2">
        <span className="text-xs font-mono uppercase tracking-widest text-[#52525b]">
          Build log
        </span>
        {reconnecting ? (
          <span className="flex items-center gap-1.5 text-xs text-[#f59e0b]" role="status">
            <PulseIcon color="#f59e0b" />
            Reconnecting…
          </span>
        ) : isStreaming ? (
          <span className="flex items-center gap-1.5 text-xs text-[#6366f1]" role="status">
            <PulseIcon />
            Running
          </span>
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
        {renderItems.map((item) =>
          item.kind === 'text' ? (
            <div
              key={item.key}
              className="text-sm text-[#f4f4f5] leading-relaxed whitespace-pre-wrap py-1"
            >
              {item.text}
            </div>
          ) : (
            <EventRow key={item.key} event={item.event} />
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
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="
              flex-shrink-0 px-3 md:px-4 py-2 md:py-2.5 rounded-xl
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

// ─── Individual event row ─────────────────────────────────────────────────────

function EventRow({ event }: { event: SseEvent }) {
  switch (event.type) {
    case 'agent_start':
      return <StatusChip label="Agent started" color="indigo" />;

    case 'turn_start':
      return (
        <StatusChip label={`Turn ${event.turnIndex + 1} started`} color="indigo" dim />
      );

    case 'turn_end':
      return (
        <StatusChip label={`Turn ${event.turnIndex + 1} complete`} color="indigo" dim />
      );

    case 'agent_end':
      return <StatusChip label="Agent finished" color="green" />;

    case 'run_complete':
      return (
        <StatusChip label="Build complete — game ready" color="green" />
      );

    case 'run_error':
      return (
        <div className="flex items-start gap-2 font-mono text-xs text-[#ef4444] bg-[#ef4444]/5 border border-[#ef4444]/10 rounded-lg px-3 py-2">
          <span className="opacity-60 flex-shrink-0">ERR</span>
          <span className="break-all">{event.error}</span>
        </div>
      );

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

    case 'thinking_delta':
      return (
        <span className="text-xs text-[#52525b] italic leading-relaxed">
          {event.delta}
        </span>
      );

    case 'tool_use':
      return <ToolChip toolName={event.toolName} status={event.status} />;

    case 'tool_result':
      return (
        <ToolChip
          toolName={event.toolName}
          status={event.success ? 'done' : 'error'}
          isResult
        />
      );

    default:
      return null;
  }
}

// ─── Tool call chip ───────────────────────────────────────────────────────────

function ToolChip({
  toolName,
  status,
  isResult = false,
}: {
  toolName: string;
  status: 'start' | 'done' | 'error';
  isResult?: boolean;
}) {
  const icon =
    status === 'done' ? '✓' : status === 'error' ? '✗' : '●';

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
      <span>{toolName}</span>
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
