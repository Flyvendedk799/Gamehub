'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import { getMe, logout } from '@/lib/api';
import { clearToken, getToken } from '@/lib/auth';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Persistent left navigation rail — the app's primary nav across every
 *  dashboard surface (home, projects, hub, settings, profile). Immersive views
 *  (the editor, the public play page, auth, onboarding) render without it; that
 *  gating lives in AppShell.
 *
 *  Responsive: an in-flow sticky rail at md+; an off-canvas overlay drawer below
 *  md, toggled by `open` and slid in/out with a transform. `onNavigate` lets the
 *  shell close the drawer when a link is tapped on mobile. */
export default function Sidebar({
  open = false,
  onNavigate,
}: {
  open?: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [handle, setHandle] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

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
    onNavigate?.();
    try {
      await logout();
    } catch {
      /* ignore */
    }
    clearToken();
    router.push('/auth/login');
  }

  const navItems: Array<{
    href: string;
    label: string;
    icon: React.ReactNode;
    match: (p: string) => boolean;
  }> = [
    {
      href: '/',
      label: 'New game',
      icon: <PlusIcon />,
      match: (p) => p === '/',
    },
    {
      href: '/projects',
      label: 'My projects',
      icon: <GridIcon />,
      match: (p) => p === '/projects' || p.startsWith('/projects/'),
    },
    {
      href: '/hub',
      label: 'Community hub',
      icon: <CompassIcon />,
      match: (p) => p.startsWith('/hub'),
    },
  ];

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex h-screen w-60 shrink-0 flex-col border-r border-[#1a1a1a] bg-[#0c0c0c] transition-transform duration-200 md:sticky md:top-0 md:z-40 md:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      {/* Brand */}
      <Link
        href="/"
        onClick={onNavigate}
        className="flex items-center gap-2 px-4 h-14 border-b border-[#1a1a1a] text-[#f4f4f5] hover:text-white transition-colors"
      >
        <BrandMark size={26} className="flex-shrink-0" />
        <Wordmark className="text-sm font-semibold" />
      </Link>

      {/* Primary nav */}
      <nav className="flex flex-col gap-1 p-3">
        {navItems.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all ${
                active
                  ? 'bg-[#6366f1]/10 text-[#f4f4f5] font-medium'
                  : 'text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#161616]'
              }`}
            >
              <span className={active ? 'text-[#818cf8]' : 'text-[#52525b]'}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Footer — credits + account */}
      <div className="border-t border-[#1a1a1a] p-3">
        {handle ? (
          <div className="flex flex-col gap-1">
            {balance !== null && (
              <span
                className="mb-1 flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#a1a1aa] rounded-lg bg-[#161616] border border-[#222222] font-mono"
                title={`${balance} credits remaining`}
              >
                <span className="text-[#f59e0b]">◆</span>
                {balance.toLocaleString()} credits
              </span>
            )}
            <Link
              href={`/u/${handle}`}
              onClick={onNavigate}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#161616] transition-all"
            >
              <span className="text-[#6366f1] font-mono">@</span>
              <span className="truncate">{handle}</span>
            </Link>
            <Link
              href="/settings"
              onClick={onNavigate}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#161616] transition-all"
            >
              <span className="text-[#52525b]">
                <GearIcon />
              </span>
              Settings
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-[#71717a] hover:text-[#ef4444] hover:bg-[#ef4444]/10 transition-all"
            >
              <span>
                <SignOutIcon />
              </span>
              Sign out
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Link
              href="/auth/login"
              onClick={onNavigate}
              className="w-full text-center px-3 py-2 text-sm text-[#a1a1aa] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
            >
              Sign in
            </Link>
            <Link
              href="/auth/register"
              onClick={onNavigate}
              className="w-full text-center px-3 py-2 text-sm bg-[#6366f1] hover:bg-[#4f46e5] text-white rounded-lg transition-all"
            >
              Sign up
            </Link>
          </div>
        )}
      </div>
    </aside>
  );
}

function PlusIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
      />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.5 8.5l-2 5-5 2 2-5 5-2z"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      className="w-4 h-4"
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
  );
}

function SignOutIcon() {
  return (
    <svg
      className="w-4 h-4"
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
  );
}
