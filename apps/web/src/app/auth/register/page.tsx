'use client';

import { createProject, generateGame, register } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { deriveProjectName, takePendingPrompt } from '@/lib/pending-prompt';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function RegisterPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('loading');
    setErrorMsg('');
    try {
      const { token } = await register(email, password, handle, displayName || undefined);
      setToken(token);

      // Phase 2.4 — replay a prompt captured on the homepage before the auth
      // wall: now that we hold a token, create the project + start the build
      // and route straight into the builder so the prompt is never lost.
      const pending = takePendingPrompt();
      if (pending) {
        try {
          const { project } = await createProject(deriveProjectName(pending), 'phaser');
          const { runId } = await generateGame(project.id, pending);
          router.push(`/projects/${project.id}?runId=${runId}`);
          return;
        } catch {
          // The account exists; if the build kick-off failed (e.g. transient),
          // fall through to the home page rather than stranding the user.
        }
      }
      router.push('/');
    } catch (err) {
      setStatus('error');
      const msg = err instanceof Error ? err.message : 'Registration failed';
      setErrorMsg(
        msg.includes('409') || msg.includes('email_or_handle_taken')
          ? 'Email or username is already taken'
          : msg,
      );
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 bg-[#0a0a0a]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2 mb-6 group">
            <div className="w-8 h-8 rounded-lg bg-[#6366f1] flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <polygon points="4,3 18,11 4,19" fill="white" />
              </svg>
            </div>
            <span className="text-lg font-semibold text-[#f4f4f5] group-hover:text-white transition-colors">
              Playforge
            </span>
          </Link>
          <h1 className="text-2xl font-bold text-[#f4f4f5]">Create an account</h1>
          <p className="mt-1 text-sm text-[#71717a]">Start building games with AI</p>
        </div>

        <div className="bg-[#111111] border border-[#222222] rounded-2xl p-6 shadow-2xl shadow-black/50">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-[#a1a1aa] mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={status === 'loading'}
                className="w-full bg-[#0a0a0a] border border-[#222222] rounded-xl px-4 py-3 text-[#f4f4f5] placeholder-[#52525b] text-sm outline-none focus:border-[#6366f1] transition-colors disabled:opacity-50"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="handle" className="block text-sm font-medium text-[#a1a1aa] mb-1.5">
                Username
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#52525b] text-sm select-none">
                  @
                </span>
                <input
                  id="handle"
                  type="text"
                  autoComplete="username"
                  required
                  minLength={2}
                  maxLength={32}
                  value={handle}
                  onChange={(e) =>
                    setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
                  }
                  disabled={status === 'loading'}
                  className="w-full bg-[#0a0a0a] border border-[#222222] rounded-xl pl-8 pr-4 py-3 text-[#f4f4f5] placeholder-[#52525b] text-sm outline-none focus:border-[#6366f1] transition-colors disabled:opacity-50"
                  placeholder="yourname"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="displayName"
                className="block text-sm font-medium text-[#a1a1aa] mb-1.5"
              >
                Display name <span className="text-[#52525b] font-normal">(optional)</span>
              </label>
              <input
                id="displayName"
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={status === 'loading'}
                className="w-full bg-[#0a0a0a] border border-[#222222] rounded-xl px-4 py-3 text-[#f4f4f5] placeholder-[#52525b] text-sm outline-none focus:border-[#6366f1] transition-colors disabled:opacity-50"
                placeholder="Your Name"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-[#a1a1aa] mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={status === 'loading'}
                className="w-full bg-[#0a0a0a] border border-[#222222] rounded-xl px-4 py-3 text-[#f4f4f5] placeholder-[#52525b] text-sm outline-none focus:border-[#6366f1] transition-colors disabled:opacity-50"
                placeholder="Min 8 characters"
              />
            </div>

            {status === 'error' && (
              <div className="flex items-start gap-2 text-sm text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg px-4 py-3">
                <span className="mt-0.5 flex-shrink-0">⚠</span>
                <span>{errorMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full py-3 rounded-xl bg-[#6366f1] hover:bg-[#4f46e5] active:bg-[#4338ca] text-white font-medium text-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20"
            >
              {status === 'loading' ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-[#52525b]">
          Already have an account?{' '}
          <Link
            href="/auth/login"
            className="text-[#6366f1] hover:text-[#818cf8] transition-colors"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
