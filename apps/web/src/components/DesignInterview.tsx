'use client';

import { fetchInterviewPlan } from '@/lib/api';
import {
  type InterviewState,
  type LayerAnswer,
  answerLayer,
  briefToPrompt,
  finishInterview,
  nextQuestion,
  skipLayer,
  startInterview,
  startInterviewFromPlan,
  toBrief,
} from '@playforge/shared/design-interview';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Is there anything worth asking about this prompt?
 *
 * A prompt that already settles every layer should go straight to the build —
 * opening an interview only to answer nothing would be a flash of empty UI.
 */
export function needsInterview(prompt: string): boolean {
  return !startInterview(prompt).done;
}

/**
 * The short conversation before the build.
 *
 * A prompt box asks one question and then goes quiet for twenty minutes. This
 * asks a few — world, who you play, the loop, how you win — and shows each
 * answer as a card, so the game visibly takes shape before a line is written
 * and a wrong turn is corrected while correcting is still free.
 *
 * It runs entirely on the client. The questions are a fixed vocabulary, not a
 * model call, so answering is instant: waiting on an LLM to ask "where is it
 * set?" would be slower than the prompt box it replaces, and worse.
 *
 * Skipping is a first-class answer and "Build it now" is always visible. This
 * has to stay a conversation someone can walk out of, not a form that must be
 * completed.
 */
export function DesignInterview({
  prompt,
  onBuild,
  onCancel,
}: {
  prompt: string;
  onBuild: (composedPrompt: string) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<InterviewState | null>(null);
  const [typed, setTyped] = useState('');

  // Draft questions for THIS prompt. Until they arrive there is nothing worth
  // showing: the static layers are a fallback for when the model cannot answer,
  // not a first screen to be replaced a second later — swapping the question
  // out from under someone mid-read is worse than a moment of waiting.
  //
  // `startedRef` guards against React 18 double-invoking effects in dev, which
  // would otherwise fire two model calls and let the slower one overwrite an
  // interview already in progress.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void fetchInterviewPlan(prompt).then((plan) => {
      if (cancelled) return;
      setState(plan === null ? startInterview(prompt) : startInterviewFromPlan(prompt, plan));
    });
    return () => {
      cancelled = true;
    };
  }, [prompt]);

  if (state === null) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <p className="font-mono text-[11px] tracking-[.16em] text-ink-4">READING YOUR IDEA</p>
        <p className="mt-1 text-sm text-ink-3">{prompt}</p>
        <div className="mt-8 border border-hairline bg-raised p-5">
          <p className="animate-pulse text-sm text-ink-4">Working out what to ask you…</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="mt-6 font-mono text-[11px] tracking-[.1em] text-ink-4 hover:text-ink-3"
        >
          ← BACK
        </button>
      </div>
    );
  }

  return (
    <InterviewBody
      state={state}
      setState={setState}
      typed={typed}
      setTyped={setTyped}
      prompt={prompt}
      onBuild={onBuild}
      onCancel={onCancel}
    />
  );
}

function InterviewBody({
  state,
  setState,
  typed,
  setTyped,
  prompt,
  onBuild,
  onCancel,
}: {
  state: InterviewState;
  setState: (next: InterviewState) => void;
  typed: string;
  setTyped: (next: string) => void;
  prompt: string;
  onBuild: (composedPrompt: string) => void;
  onCancel: () => void;
}) {
  const question = useMemo(() => nextQuestion(state), [state]);
  const brief = useMemo(() => toBrief(state), [state]);

  function build(next: InterviewState) {
    onBuild(briefToPrompt(toBrief(finishInterview(next))));
  }

  /**
   * Apply an answer and, if that was the last question, build.
   *
   * Answering the final question and starting the build is one user action, so
   * it is one handler — not a state write that a render-phase effect notices
   * afterwards.
   */
  function advance(next: InterviewState) {
    setTyped('');
    if (nextQuestion(next) === null) {
      build(next);
      return;
    }
    setState(next);
  }

  // Answered / total, so the number of questions left is visible up front —
  // an unknown number of questions is what makes a form feel endless.
  const answered = state.answers.filter((a) => a.source !== 'inferred').length;
  const total = answered + state.remaining.length;

  function record(answer: LayerAnswer) {
    advance(answerLayer(state, answer));
  }

  const decisions =
    brief.layers.length === 0 ? null : (
      // The decisions so far. These are the point: the game accumulating in
      // front of you rather than a spinner.
      <ul className="mt-6 flex flex-col gap-2">
        {brief.layers.map((layer) => (
          <li
            key={layer.layer}
            className="flex items-baseline gap-3 border border-hairline bg-raised px-4 py-2.5"
          >
            <span className="font-mono text-[10px] tracking-[.14em] text-ink-4">
              {layer.title.toUpperCase()}
            </span>
            <span className="flex-1 text-sm text-ink">{layer.value}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <p className="font-mono text-[11px] tracking-[.16em] text-ink-4">
        DESIGNING{total > 0 ? ` · ${Math.min(answered + 1, total)}/${total}` : ''}
      </p>
      <p className="mt-1 text-sm text-ink-3">{prompt}</p>

      {decisions}

      {question === null ? (
        // The prompt already answered everything the interview knows to ask.
        // The parent gates on `needsInterview`, so this is a backstop rather
        // than a path people normally see — but it must not be a dead end.
        <div className="mt-8 border border-hairline bg-raised p-5">
          <p className="text-base font-semibold text-ink">That is everything I need.</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-4">
            Your prompt already settles the parts I would have asked about.
          </p>
          <button
            type="button"
            onClick={() => build(state)}
            className="mt-4 font-mono text-[11px] tracking-[.1em] text-signal hover:underline"
          >
            BUILD IT →
          </button>
        </div>
      ) : (
        <div className="mt-8 border border-hairline bg-raised p-5">
          <p className="text-base font-semibold text-ink">{question.question}</p>
          {/* Why it is being asked — this is what stops it reading as a form. */}
          <p className="mt-1 text-xs leading-relaxed text-ink-4">{question.why}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {question.options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() =>
                  record({
                    layer: question.id,
                    option: option.id,
                    value: option.label,
                    source: 'chosen',
                  })
                }
                className="border border-hairline px-3 py-2 text-left transition-colors hover:border-signal"
              >
                <span className="block text-sm text-ink">{option.label}</span>
                {option.detail !== undefined && (
                  <span className="block text-[11px] text-ink-4">{option.detail}</span>
                )}
              </button>
            ))}
          </div>

          <form
            className="mt-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.trim().length === 0) return;
              record({
                layer: question.id,
                option: null,
                value: typed.trim(),
                source: 'typed',
              });
            }}
          >
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={question.placeholder}
              aria-label={question.question}
              className="flex-1 border border-hairline bg-transparent px-3 py-2 text-sm text-ink placeholder-ink-4 outline-none focus:border-signal"
            />
            <button
              type="submit"
              disabled={typed.trim().length === 0}
              className="border border-hairline px-3 py-2 font-mono text-[11px] tracking-[.1em] text-ink-3 disabled:opacity-40"
            >
              USE THIS
            </button>
          </form>

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={() => advance(skipLayer(state, question.id))}
              className="font-mono text-[11px] tracking-[.1em] text-ink-4 hover:text-ink-3"
            >
              YOU DECIDE
            </button>
            <button
              type="button"
              onClick={() => build(state)}
              className="font-mono text-[11px] tracking-[.1em] text-signal hover:underline"
            >
              BUILD IT NOW →
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="mt-6 font-mono text-[11px] tracking-[.1em] text-ink-4 hover:text-ink-3"
      >
        ← BACK
      </button>
    </div>
  );
}
