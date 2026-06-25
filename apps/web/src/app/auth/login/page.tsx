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
          className="w-full bg-[#111111] border border-[#222222] rounded-xl px-4 py-3 text-[#f4f4f5] placeholder-[#52525b] text-sm outline-none focus:border-[#6366f1] transition-colors disabled:opacity-50"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-[#a1a1aa] mb-1.5">
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
          className="w-full bg-[#111111] border border-[#222222] rounded-xl px-4 py-3 text-[#f4f4f5] placeholder-[#52525b] text-sm outline-none focus:border-[#6366f1] transition-colors disabled:opacity-50"
          placeholder="••••••••"
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
        className="w-full py-4 rounded-xl bg-[#6366f1] hover:bg-[#4f46e5] active:bg-[#4338ca] text-white font-medium text-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20"
      >
        {status === 'loading' ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 bg-[#0a0a0a] safe-top safe-bottom">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2 mb-6 group">
            <BrandMark size={32} />
            <Wordmark className="text-lg font-semibold text-[#f4f4f5] group-hover:text-white transition-colors" />
          </Link>
          <h1 className="text-2xl font-bold text-[#f4f4f5]">Welcome back</h1>
          <p className="mt-1 text-sm text-[#71717a]">Sign in to your account to continue</p>
        </div>

        <div className="bg-[#111111] border border-[#222222] rounded-2xl p-6 shadow-2xl shadow-black/50">
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-4 text-center text-sm text-[#52525b]">
          Don&apos;t have an account?{' '}
          <Link
            href="/auth/register"
            className="inline-block py-2 px-3 text-[#6366f1] hover:text-[#818cf8] transition-colors"
          >
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
