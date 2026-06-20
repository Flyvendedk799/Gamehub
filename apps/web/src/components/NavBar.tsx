'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import { getMe, logout } from '@/lib/api';
import { clearToken, getToken } from '@/lib/auth';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function NavBar() {
  const router = useRouter();
  const pathname = usePathname();
  const [handle, setHandle] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended trigger — re-fetch the current user on route change
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setHandle(null);
      setBalance(null);
      return;
    }
    let cancelled = false;
    void getMe()
      .then((data) => {
        if (cancelled) return;
        setHandle(data.handle);
        setBalance(data.balance ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setHandle(null);
        setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  async function handleLogout() {
    setMenuOpen(false);
    try {
      await logout();
    } catch {
      /* ignore */
    }
    clearToken();
    router.push('/auth/login');
  }

  const isAuthPage = pathname.startsWith('/auth/');
  const isSetupPage = pathname.startsWith('/onboarding');
  if (isAuthPage || isSetupPage) return null;

  return (
    <nav className="fixed top-0 inset-x-0 z-50 h-12 flex items-center justify-between px-4 bg-[#0a0a0a]/80 backdrop-blur border-b border-[#1a1a1a]">
      <Link
        href="/"
        className="flex items-center gap-2 text-[#f4f4f5] hover:text-white transition-colors"
      >
        <BrandMark size={24} className="flex-shrink-0" />
        <Wordmark className="text-sm font-semibold" />
      </Link>

      <div className="flex items-center gap-1">
        <Link
          href="/hub"
          className="px-3 py-1.5 text-xs text-[#71717a] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
        >
          Hub
        </Link>

        {handle && balance !== null && (
          <span
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-[#a1a1aa] rounded-lg bg-[#161616] border border-[#222222] font-mono"
            title={`${balance} credits remaining`}
            aria-label={`${balance} credits remaining`}
          >
            <span className="text-[#f59e0b]">◆</span>
            {balance.toLocaleString()}
          </span>
        )}

        {handle ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#a1a1aa] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
            >
              <span className="text-[#6366f1]">@</span>
              {handle}
              <svg
                className={`w-3 h-3 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-[#111111] border border-[#222222] rounded-xl shadow-xl shadow-black/50 overflow-hidden">
                <Link
                  href={`/u/${handle}`}
                  className="flex items-center gap-2 px-3 py-2.5 text-xs text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#161616] transition-all"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
                  Profile
                </Link>
                <Link
                  href="/settings"
                  className="flex items-center gap-2 px-3 py-2.5 text-xs text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#161616] transition-all"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.827 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.827 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.827-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.827-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  Settings
                </Link>
                <div className="h-px bg-[#222222]" />
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[#ef4444] hover:bg-[#ef4444]/10 transition-all"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                    />
                  </svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <Link
              href="/auth/login"
              className="px-3 py-1.5 text-xs text-[#71717a] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
            >
              Sign in
            </Link>
            <Link
              href="/auth/register"
              className="px-3 py-1.5 text-xs bg-[#6366f1] hover:bg-[#4f46e5] text-white rounded-lg transition-all"
            >
              Sign up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
