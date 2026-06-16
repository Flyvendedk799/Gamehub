'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { logout } from '@/lib/api';
import { clearToken, getToken } from '@/lib/auth';

export default function NavBar() {
  const router = useRouter();
  const pathname = usePathname();
  const [handle, setHandle] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) { setHandle(null); return; }
    fetch(`${process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3191'}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() as Promise<{ handle: string }> : Promise.resolve(null))
      .then((data) => setHandle(data?.handle ?? null))
      .catch(() => setHandle(null));
  }, [pathname]);

  async function handleLogout() {
    setMenuOpen(false);
    try { await logout(); } catch { /* ignore */ }
    clearToken();
    router.push('/auth/login');
  }

  const isAuthPage = pathname.startsWith('/auth/');
  if (isAuthPage) return null;

  return (
    <nav className="fixed top-0 inset-x-0 z-50 h-12 flex items-center justify-between px-4 bg-[#0a0a0a]/80 backdrop-blur border-b border-[#1a1a1a]">
      <Link
        href="/"
        className="flex items-center gap-2 text-[#f4f4f5] hover:text-white transition-colors"
      >
        <div className="w-6 h-6 rounded-md bg-[#6366f1] flex items-center justify-center flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 22 22" fill="none">
            <polygon points="4,3 18,11 4,19" fill="white" />
          </svg>
        </div>
        <span className="text-sm font-semibold">Playforge</span>
      </Link>

      <div className="flex items-center gap-1">
        <Link
          href="/hub"
          className="px-3 py-1.5 text-xs text-[#71717a] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
        >
          Hub
        </Link>

        {handle ? (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#a1a1aa] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
            >
              <span className="text-[#6366f1]">@</span>{handle}
              <svg className={`w-3 h-3 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-[#111111] border border-[#222222] rounded-xl shadow-xl shadow-black/50 overflow-hidden">
                <Link
                  href={`/u/${handle}`}
                  className="flex items-center gap-2 px-3 py-2.5 text-xs text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#161616] transition-all"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Profile
                </Link>
                <div className="h-px bg-[#222222]" />
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[#ef4444] hover:bg-[#ef4444]/10 transition-all"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
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
