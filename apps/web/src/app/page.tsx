'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import ProjectCard from '@/components/ProjectCard';
import { createProject, generateGame, listProjects } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import {
  GAME_EXAMPLE_BRIEFS,
  type GameExampleBrief,
  briefEngineToApiEngine,
  briefToPrompt,
} from '@/lib/example-briefs';
import { deriveProjectName, setPendingPrompt } from '@/lib/pending-prompt';
import type { Engine, Project } from '@/lib/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export default function HomePage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [recent, setRecent] = useState<Project[] | null>(null);
  const [authed, setAuthed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Lovable-style dashboard: when signed in, the home is a compact dashboard (tight
  // greeting + build box + your recent projects). Logged-out visitors get the full
  // marketing hero. `authed` drives that split; it's set client-side post-mount.
  useEffect(() => {
    const ok = isAuthenticated();
    setAuthed(ok);
    if (!ok) return;
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
   * Shared build path (#3.5). The homepage form and the example chips both flow
   * through here so a chip click runs the exact same auth-aware / pending-prompt
   * logic as typing a prompt. `engine` defaults to phaser for free-text submits;
   * chips pass the brief's mapped engine.
   */
  async function startBuild(rawPrompt: string, engine: Engine = 'phaser') {
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

      const { project } = await createProject(name, engine);
      const { runId } = await generateGame(project.id, trimmed);

      router.push(`/projects/${project.id}?runId=${runId}`);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await startBuild(prompt);
  }

  // #3.5 — one-click build from an example chip: submit the real brief through
  // the same path (auth-aware, pending-prompt) as a typed prompt. No need to
  // populate the textarea first; the click IS the submit.
  function useExample(brief: GameExampleBrief) {
    void startBuild(briefToPrompt(brief), briefEngineToApiEngine(brief.engine));
  }

  const isLoading = status === 'loading';
  const hasRecent = recent !== null && recent.length > 0;

  return (
    <main
      className={`flex min-h-dvh flex-col items-center px-4 py-16 bg-[#0a0a0a] ${
        authed ? '' : 'justify-center'
      }`}
    >
      {authed ? (
        /* Signed-in: compact dashboard greeting (the sidebar carries the brand) */
        <div className="mb-8 w-full max-w-2xl text-center">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#f4f4f5]">
            What do you want to build?
          </h1>
        </div>
      ) : (
        /* Logged-out: full marketing hero */
        <div className="mb-12 text-center">
          <div className="inline-flex items-center gap-3 mb-4">
            <BrandMark size={40} />
            <Wordmark className="text-2xl font-semibold tracking-tight text-[#f4f4f5]" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-[#f4f4f5] leading-tight">
            Build games with AI
          </h1>
          <p className="mt-4 text-lg text-[#a1a1aa] max-w-md mx-auto">
            Describe the game you want. PlayerZero writes the code, builds it, and gives you
            something you can play instantly.
          </p>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="w-full max-w-2xl">
        <div className="relative rounded-2xl border border-[#222222] bg-[#111111] shadow-2xl shadow-black/50 overflow-hidden focus-within:border-[#6366f1] transition-colors duration-200">
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
            placeholder="What game do you want to build? Describe the genre, mechanics, art style…"
            rows={5}
            disabled={isLoading}
            className="w-full bg-transparent px-5 pt-5 pb-2 text-[#f4f4f5] placeholder-[#52525b] text-base resize-none outline-none disabled:opacity-50"
          />
          <div className="flex items-center justify-between px-5 pb-4 pt-2">
            <span className="hidden sm:inline text-xs text-[#52525b]">⌘ + Enter to submit</span>
            <button
              type="submit"
              disabled={isLoading || !prompt.trim()}
              className="
                inline-flex items-center gap-2 px-5 py-3 sm:py-2.5 rounded-xl
                bg-[#6366f1] hover:bg-[#4f46e5] active:bg-[#4338ca]
                text-white font-medium text-sm
                transition-all duration-150
                disabled:opacity-40 disabled:cursor-not-allowed
                shadow-lg shadow-indigo-500/20
              "
            >
              {isLoading ? (
                <>
                  <Spinner />
                  Building…
                </>
              ) : (
                'Build it →'
              )}
            </button>
          </div>
        </div>

        {status === 'error' && (
          <div className="mt-3 flex items-start gap-2 text-sm text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg px-4 py-3">
            <span className="mt-0.5 flex-shrink-0">⚠</span>
            <span>{errorMsg}</span>
          </div>
        )}
      </form>

      {/* Example chips — one-click builds (#3.5) */}
      <div className="mt-8 w-full max-w-2xl">
        <p className="text-xs text-[#52525b] uppercase tracking-widest mb-3 text-center">
          Or build one of these in one click
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {GAME_EXAMPLE_BRIEFS.map((brief) => (
            <button
              key={brief.slug}
              type="button"
              onClick={() => useExample(brief)}
              disabled={isLoading}
              title={brief.brief}
              className="
                group flex items-center justify-between gap-2 text-left
                bg-[#111111] hover:bg-[#161616]
                border border-[#222222] hover:border-[#6366f1]/40
                rounded-xl px-4 py-3
                transition-all duration-150
                disabled:opacity-40 disabled:cursor-not-allowed
              "
            >
              <span className="text-sm text-[#a1a1aa] group-hover:text-[#f4f4f5] truncate">
                {brief.label}
              </span>
              <span className="flex-shrink-0 text-xs text-[#52525b] group-hover:text-[#6366f1] opacity-0 group-hover:opacity-100 transition-opacity">
                Build →
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Recent projects — the dashboard hub (signed-in only) */}
      {hasRecent && recent && (
        <section className="mt-16 w-full max-w-5xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-[#f4f4f5] uppercase tracking-wider">
              Recent projects
            </h2>
            <Link
              href="/projects"
              className="text-xs text-[#71717a] hover:text-[#6366f1] transition-colors"
            >
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {recent.slice(0, 6).map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="mt-16 flex items-center gap-4">
        <p className="text-xs text-[#3f3f46]">PlayerZero — Phase 0 · Dev build</p>
      </div>
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
