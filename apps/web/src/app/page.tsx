'use client';

import { DesignInterview, needsInterview } from '@/components/DesignInterview';
import { BrandMark, Wordmark } from '@/components/Logo';
import ProjectCard from '@/components/ProjectCard';
import { createProject, generateGame, listProjects } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import type { EngineChoice } from '@/lib/engine-api';
import {
  GAME_EXAMPLE_BRIEFS,
  type GameExampleBrief,
  briefEngineToApiEngine,
  briefToPrompt,
} from '@/lib/example-briefs';
import { deriveProjectName, setPendingPrompt, takePendingPrompt } from '@/lib/pending-prompt';
import type { Project } from '@/lib/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export default function HomePage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  // 'auto' is the default: most people describing a game do not know or care
  // whether it wants 2D or 3D, and the agent's choose_engine is better at that
  // decision than a chip is. Picking one explicitly still pins it.
  const [engine, setEngine] = useState<EngineChoice>('auto');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [recent, setRecent] = useState<Project[] | null>(null);
  const [authed, setAuthed] = useState(false);
  /**
   * The prompt waiting on the design interview.
   *
   * Set when someone submits something the interview can usefully ask about;
   * cleared when they build or go back. While it is set the interview replaces
   * the page, because a few questions answered up front are worth far more than
   * a build that guessed.
   */
  const [interviewPrompt, setInterviewPrompt] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Signed in, the home is the production console's dashboard (identity board
  // 1b: kicker + display greeting + prompt slot + idea grid + recent projects).
  // Logged-out visitors get the marketing hero. `authed` drives that split;
  // it's set client-side post-mount.
  useEffect(() => {
    const ok = isAuthenticated();
    setAuthed(ok);
    if (!ok) return;

    // A prompt handed back by onboarding: someone who submitted an idea logged
    // out, signed up, and is owed the interview they would have had. Onboarding
    // builds anything that does not need asking about, so whatever arrives here
    // does — but build it rather than drop it if that ever stops being true.
    const pending = takePendingPrompt();
    if (pending !== null) {
      if (needsInterview(pending)) setInterviewPrompt(pending);
      else void startBuild(pending);
    }

    let cancelled = false;
    void listProjects()
      .then(({ projects }) => {
        if (!cancelled) setRecent(projects);
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Shared build path (#3.5). The dashboard form and the idea chips both flow
   * through here so a chip click runs the exact same auth-aware / pending-prompt
   * logic as typing a prompt. Typed submits carry the engine chip selection;
   * idea chips pass the brief's mapped engine.
   */
  async function startBuild(rawPrompt: string, buildEngine: EngineChoice = 'auto') {
    const trimmed = rawPrompt.trim();
    if (!trimmed) return;

    setStatus('loading');
    setErrorMsg('');

    // Phase 2.4 — auth-aware submit. A logged-out visitor's prompt must NOT be
    // lost at the 401 wall: stash it and route through register, which replays
    // it after a token lands and continues straight into the build.
    if (!isAuthenticated()) {
      setPendingPrompt(trimmed);
      router.push('/auth/register?next=build');
      return;
    }

    try {
      const name = deriveProjectName(trimmed);

      const { project } = await createProject(name, buildEngine);
      const { runId } = await generateGame(project.id, trimmed);

      router.push(`/projects/${project.id}?runId=${runId}`);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;

    // The interview drafts its questions server-side, so it needs a token: a
    // logged-out visitor who reached it would be handed a 401 and therefore the
    // generic questions. Sign-up first, and the prompt comes back here to be
    // asked about properly (see the pending-prompt handoff above).
    if (!isAuthenticated()) {
      setPendingPrompt(trimmed);
      router.push('/auth/register?next=build');
      return;
    }

    // Ask before building — but only when there is something worth asking. A
    // prompt that already names its world, loop and win condition goes straight
    // through rather than being interrogated about what it just said.
    if (needsInterview(trimmed)) {
      setInterviewPrompt(trimmed);
      return;
    }
    await startBuild(trimmed, engine);
  }

  // #3.5 — one-click build from an idea chip: submit the real brief through
  // the same path (auth-aware, pending-prompt) as a typed prompt. No need to
  // populate the textarea first; the click IS the submit.
  //
  // Chips skip the interview on purpose: the brief behind a chip already
  // specifies its world, loop and win condition, so the click means "this one",
  // not "let us discuss it".
  function useExample(brief: GameExampleBrief) {
    void startBuild(briefToPrompt(brief), briefEngineToApiEngine(brief.engine));
  }

  if (interviewPrompt !== null) {
    return (
      <DesignInterview
        prompt={interviewPrompt}
        onBuild={(composed) => {
          setInterviewPrompt(null);
          void startBuild(composed, engine);
        }}
        onCancel={() => setInterviewPrompt(null)}
      />
    );
  }

  const isLoading = status === 'loading';
  const hasRecent = recent !== null && recent.length > 0;

  const promptForm = (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="border border-hairline bg-surface transition-colors focus-within:border-signal">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (status === 'error') setStatus('idle');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              void handleSubmit(e);
            }
          }}
          placeholder="Describe the game you want. Genre, mechanics, art style…"
          rows={3}
          disabled={isLoading}
          className="w-full resize-none bg-transparent px-6 pb-2 pt-6 text-lg leading-normal text-ink placeholder-ink-4 outline-none disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline py-3.5 pl-6 pr-4">
          {/* Engine chips — the typed submit builds with the selected engine */}
          <div className="flex gap-2 font-mono text-[11px] tracking-[.1em]">
            {(
              [
                ['auto', 'AUTO'],
                ['phaser', 'PHASER 2D'],
                ['threejs', 'THREE.JS 3D'],
                ['vanilla', 'CANVAS 2D'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setEngine(value)}
                aria-pressed={engine === value}
                className={`border px-3 py-[7px] transition-colors ${
                  engine === value
                    ? 'border-signal bg-raised text-signal'
                    : 'border-hairline text-ink-4 hover:text-ink-3'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden font-mono text-[11px] tracking-[.08em] text-ink-4 sm:inline">
              ⌘ ENTER
            </span>
            <button
              type="submit"
              disabled={isLoading || !prompt.trim()}
              className="inline-flex items-center gap-2 bg-signal px-6 py-3 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isLoading ? (
                <>
                  <Spinner />
                  Building…
                </>
              ) : (
                'Build it'
              )}
            </button>
          </div>
        </div>
      </div>

      {status === 'error' && (
        <div className="mt-3 flex items-start gap-2 border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
          <span className="mt-0.5 flex-shrink-0">⚠</span>
          <span>{errorMsg}</span>
        </div>
      )}
    </form>
  );

  const ideaGrid = (
    <div className="w-full">
      <div className="grid grid-cols-1 gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
        {GAME_EXAMPLE_BRIEFS.slice(0, 4).map((brief) => (
          <button
            key={brief.slug}
            type="button"
            onClick={() => useExample(brief)}
            disabled={isLoading}
            title={brief.brief}
            className="bg-ground px-4 py-4 text-left transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
          >
            <div className="type-label-xs mb-2 text-signal">{brief.genre}</div>
            <div className="text-sm leading-snug text-ink-2">{brief.label}</div>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <main className="min-h-dvh bg-ground">
      {authed ? (
        /* Signed in — the console dashboard (board 1b) */
        <div className="mx-auto w-full max-w-[1100px] px-5 py-12 sm:px-10 md:py-16 lg:px-[72px]">
          <div className="flex flex-wrap items-end justify-between gap-8">
            <div>
              <div className="type-label mb-4 text-ink-4">Slot zero · Ready</div>
              <h1 className="type-display text-4xl text-ink sm:text-5xl md:text-6xl">
                What are we
                <br />
                building today?
              </h1>
            </div>
            {recent !== null && (
              <div className="text-right font-mono text-[11px] leading-8 tracking-[.1em] text-ink-4">
                <div>
                  {recent.length} PROJECT{recent.length === 1 ? '' : 'S'}
                </div>
              </div>
            )}
          </div>

          <div className="mt-11">{promptForm}</div>
          <div className="mt-5">{ideaGrid}</div>

          {/* Recent projects */}
          {hasRecent && recent && (
            <section className="mt-16">
              <div className="flex items-baseline justify-between border-b border-hairline pb-3.5">
                <h2 className="type-title text-2xl text-ink">Recent projects</h2>
                <Link
                  href="/projects"
                  className="font-mono text-[11px] tracking-[.14em] text-ink-3 transition-colors hover:text-signal"
                >
                  ALL {recent.length} →
                </Link>
              </div>
              <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {recent.slice(0, 6).map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (
        /* Logged out — marketing hero in the same identity */
        <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center px-5 py-16">
          <div className="mb-12 text-center">
            <div className="mb-6 inline-flex items-center gap-3">
              <BrandMark size={40} />
              <Wordmark className="text-2xl text-ink" />
            </div>
            <h1 className="type-display text-4xl text-ink sm:text-6xl">
              Build the game
              <br />
              you describe
            </h1>
            <p className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-ink-3">
              Describe the game you want. PlayerZero writes the code, builds it, and hands you
              something you can play instantly.
            </p>
          </div>

          {promptForm}
          <div className="mt-6 w-full">
            <p className="type-label mb-3 text-center text-ink-4">Or build one of these</p>
            {ideaGrid}
          </div>

          {/* Footer */}
          <div className="mt-16 flex items-center gap-4">
            <p className="font-mono text-[11px] tracking-[.08em] text-ink-4">
              PLAYERZERO — PHASE 0 · DEV BUILD
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
