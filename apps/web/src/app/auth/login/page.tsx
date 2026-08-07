'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import { login } from '@/lib/api';
import { setToken } from '@/lib/auth';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('loading');
    setErrorMsg('');
    try {
      const { token } = await login(email, password);
      setToken(token);
      router.push(next);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Invalid credentials');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="email" className="type-label-xs mb-2 block tracking-[.14em] text-ink-3">
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
        <label htmlFor="password" className="type-label-xs mb-2 block tracking-[.14em] text-ink-3">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={status === 'loading'}
          className="w-full border border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal disabled:opacity-50"
          placeholder="••••••••"
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
        {status === 'loading' ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-void px-4 safe-top safe-bottom">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link href="/" className="group mb-7 inline-flex items-center gap-2.5">
            <BrandMark size={32} />
            <Wordmark className="text-lg text-ink transition-colors group-hover:text-white" />
          </Link>
          <h1 className="type-title text-2xl text-ink">Welcome back</h1>
          <p className="mt-1.5 text-sm text-ink-3">Sign in and pick up where you left off.</p>
        </div>

        <div className="border border-hairline bg-ground p-6">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-4 text-center text-sm text-ink-4">
          Don&apos;t have an account?{' '}
          <Link
            href="/auth/register"
            className="inline-block px-3 py-2 text-signal transition-colors hover:text-signal-bright"
          >
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
