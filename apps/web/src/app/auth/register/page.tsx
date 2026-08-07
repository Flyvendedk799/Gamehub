'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import { register } from '@/lib/api';
import { setToken } from '@/lib/auth';
import { hasPendingPrompt } from '@/lib/pending-prompt';
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

      router.push(hasPendingPrompt() ? '/onboarding?next=build' : '/onboarding');
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
    <main className="flex min-h-dvh flex-col items-center justify-center bg-void px-4 safe-top safe-bottom">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="group mb-7 inline-flex items-center gap-2.5">
            <BrandMark size={32} />
            <Wordmark className="text-lg text-ink transition-colors group-hover:text-white" />
          </Link>
          <h1 className="type-title text-2xl text-ink">Create an account</h1>
          <p className="mt-1.5 text-sm text-ink-3">Describe a game. Play it minutes later.</p>
        </div>

        <div className="border border-hairline bg-ground p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
              >
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
                className="w-full border border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal disabled:opacity-50"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label
                htmlFor="handle"
                className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
              >
                Username
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 select-none text-sm text-ink-4">
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
                  className="w-full border border-hairline bg-surface py-3 pl-8 pr-4 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal disabled:opacity-50"
                  placeholder="yourname"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="displayName"
                className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
              >
                Display name <span className="normal-case text-ink-4">(optional)</span>
              </label>
              <input
                id="displayName"
                type="text"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={status === 'loading'}
                className="w-full border border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal disabled:opacity-50"
                placeholder="Your Name"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
              >
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
                className="w-full border border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal disabled:opacity-50"
                placeholder="Min 8 characters"
              />
            </div>

            {status === 'error' && (
              <div className="flex items-start gap-2 border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
                <span className="mt-0.5 flex-shrink-0">⚠</span>
                <span>{errorMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full bg-signal py-4 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === 'loading' ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-ink-4">
          Already have an account?{' '}
          <Link
            href="/auth/login"
            className="inline-block px-3 py-2 text-signal transition-colors hover:text-signal-bright"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
