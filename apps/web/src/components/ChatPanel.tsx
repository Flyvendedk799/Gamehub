'use client';

import { type ChatTurn, buildTurns } from '@/lib/run-turns';
import type { SseEvent } from '@/lib/types';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AgentTurnView } from './chat/AgentTurnView';
import { ArrowUp, Spinner } from './chat/icons';

interface ChatPanelProps {
  events: SseEvent[];
  onSend: (prompt: string) => void;
  isStreaming: boolean;
  /** When set, a transient SSE disconnect is being retried (#10). */
  reconnecting?: boolean;
  /**
   * One-click "Try again" after a failed run. Called with the prior error string so the builder
   * can start a new run whose prompt includes it. Only offered for genuine run errors, never for
   * the transport "lost connection" case.
   */
  onFixError?: (error: string) => void;
  /**
   * Resume a paused long run. Re-fires generateGame; the server auto-applies the stored
   * continuation.
   */
  onResume?: () => void;
}

/** Ideas offered after a finished turn. Tapping one fills the box; nothing is sent until you do. */
const FOLLOW_UPS = [
  'Make it look more polished',
  'Add sound effects and screen shake',
  'Make it a bit harder as I progress',
];

/** Ideas for an empty chat. */
const STARTERS = [
  'Make a 2D platformer with a double jump',
  'Make a sword duel on a bridge',
  'Make an endless runner with power-ups',
];

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const [hasNewUpdates, setHasNewUpdates] = useState(false);

  const turns = useMemo(
    () => buildTurns(events, { streaming: isStreaming }),
    [events, isStreaming],
  );

  // Stay at the bottom as the agent works, unless the player scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `turns` is the trigger — every change to the conversation re-evaluates the scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followLatest.current) {
      el.scrollTop = el.scrollHeight;
    } else if (el) {
      setHasNewUpdates(true);
    }
  }, [turns]);

  // One clock for the working timer, ticking only while a run is live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  // The box grows with what is typed, up to a limit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `input` is the trigger — the height must be re-measured whenever the text changes
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  function send(prompt: string) {
    const text = prompt.trim();
    if (!text || isStreaming) return;
    followLatest.current = true;
    onSend(text);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;
    send(text);
    setInput('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter writes a new line. Composition (IME) Enter must stay untouched.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  function fill(text: string) {
    setInput(text);
    inputRef.current?.focus();
  }

  const last = turns[turns.length - 1];
  const showFollowUps =
    !isStreaming && (last === undefined || (last.kind === 'agent' && last.status === 'done'));
  const lastAgentIndex = lastIndexOfAgent(turns);

  return (
    <div className="flex h-full flex-col border-r border-hairline bg-chrome">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-hairline px-4 py-2.5 md:py-3">
        <span className="type-label text-ink">Chat</span>
        {reconnecting && (
          <output className="flex items-center gap-1.5 text-[11px] text-live">
            <Spinner size={11} />
            Reconnecting…
          </output>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          role="log"
          onScroll={(event) => {
            const el = event.currentTarget;
            followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (followLatest.current) setHasNewUpdates(false);
          }}
          className="scrollbar-thin h-full space-y-5 overflow-y-auto px-3 py-4 md:px-4"
        >
          {turns.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
              <p className="text-sm text-ink-3">Describe a game, or a change to make.</p>
            </div>
          )}

          {turns.map((turn, index) =>
            turn.kind === 'user' ? (
              <UserBubble key={turn.key} text={turn.text} />
            ) : (
              <AgentTurnView
                key={turn.key}
                turn={turn}
                nowMs={nowMs}
                isLatest={index === lastAgentIndex && index === turns.length - 1}
                onFixIssues={send}
                onRetry={onFixError}
                onResume={onResume}
                onAnswer={onSend}
              />
            ),
          )}

          {showFollowUps && (
            <div className="flex flex-wrap gap-2 pt-1">
              {(last === undefined ? STARTERS : FOLLOW_UPS).map((idea) => (
                <button
                  key={idea}
                  type="button"
                  onClick={() => fill(idea)}
                  className="rounded-full border border-hairline bg-surface px-3 py-1.5 text-xs text-ink-3 transition-colors hover:border-signal hover:text-ink"
                >
                  {idea}
                </button>
              ))}
            </div>
          )}
        </div>

        {hasNewUpdates && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-hairline bg-surface px-3 py-1.5 text-xs text-ink-2 shadow-lg transition-colors hover:text-ink"
            onClick={() => {
              followLatest.current = true;
              setHasNewUpdates(false);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            New updates ↓
          </button>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-hairline bg-ground p-3 md:p-4">
        <div className="rounded-2xl border border-hairline bg-surface transition-colors focus-within:border-signal">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming ? 'Working on it. You can write your next request…' : 'Ask for a change…'
            }
            rows={1}
            aria-label="Message"
            className="block max-h-40 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-ink placeholder-ink-4 outline-none"
          />
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <span className="hidden text-[11px] text-ink-4 sm:inline">
              {isStreaming ? 'Working…' : 'Enter to send · Shift+Enter for a new line'}
            </span>
            <button
              type="button"
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
              aria-label="Send"
              className="ml-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-signal text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-30"
            >
              {isStreaming ? <Spinner size={14} /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-hairline bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-ink">
        {text}
      </div>
    </div>
  );
}

function lastIndexOfAgent(turns: ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.kind === 'agent') return i;
  }
  return -1;
}
