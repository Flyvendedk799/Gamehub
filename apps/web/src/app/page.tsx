'use client';

import { createProject, generateGame } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { deriveProjectName, setPendingPrompt } from '@/lib/pending-prompt';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

const EXAMPLE_PROMPTS = [
  'A top-down space shooter with asteroids and power-ups',
  'A side-scrolling platformer with a ninja character',
  'A tower defense game with colorful enemies',
  'A snake game with a neon aesthetic and high score tracking',
];

export default function HomePage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
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

      const { project } = await createProject(name, 'phaser');
      const { runId } = await generateGame(project.id, trimmed);

      router.push(`/projects/${project.id}?runId=${runId}`);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  function useExample(example: string) {
    setPrompt(example);
    textareaRef.current?.focus();
  }

  const isLoading = status === 'loading';

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-16 bg-[#0a0a0a]">
      {/* Logo / wordmark */}
      <div className="mb-12 text-center">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[#6366f1] flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <polygon points="4,3 18,11 4,19" fill="white" />
            </svg>
          </div>
          <span className="text-2xl font-semibold tracking-tight text-[#f4f4f5]">Playforge</span>
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold text-[#f4f4f5] leading-tight">
          Build games with AI
        </h1>
        <p className="mt-4 text-lg text-[#a1a1aa] max-w-md mx-auto">
          Describe the game you want. Playforge writes the code, builds it, and gives you something
          you can play instantly.
        </p>
      </div>

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
            <span className="text-xs text-[#52525b]">⌘ + Enter to submit</span>
            <button
              type="submit"
              disabled={isLoading || !prompt.trim()}
              className="
                inline-flex items-center gap-2 px-5 py-2.5 rounded-xl
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

      {/* Example prompts */}
      <div className="mt-8 w-full max-w-2xl">
        <p className="text-xs text-[#52525b] uppercase tracking-widest mb-3 text-center">
          Try an example
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {EXAMPLE_PROMPTS.map((ex) => (
            <button
              key={ex}
              onClick={() => useExample(ex)}
              disabled={isLoading}
              className="
                text-left text-sm text-[#a1a1aa] hover:text-[#f4f4f5]
                bg-[#111111] hover:bg-[#161616]
                border border-[#222222] hover:border-[#333333]
                rounded-xl px-4 py-3
                transition-all duration-150
                disabled:opacity-40 disabled:cursor-not-allowed
              "
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-16 flex items-center gap-4">
        <p className="text-xs text-[#3f3f46]">Playforge — Phase 0 · Dev build</p>
        <span className="text-[#2a2a2a]">·</span>
        <Link href="/hub" className="text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors">
          Community Hub
        </Link>
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
