'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import { getMe, logout } from '@/lib/api';
import { clearToken, getToken } from '@/lib/auth';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Persistent left navigation rail — the app's primary nav across every
 *  dashboard surface (home, projects, hub, settings, profile). AppShell mounts
 *  it on those surfaces; the project editor (/projects/:id) embeds its own
 *  instance directly so the nav is present there too. The remaining chromeless
 *  views (public play page, auth, onboarding) render without it.
 *
 *  Visual language (identity board 1b): a 232px chrome-dark rail on a shared
 *  hairline; text-only items whose active state is a 2px signal left border on
 *  a raised surface; mono section labels; the credits block pinned to the foot.
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
    match: (p: string) => boolean;
  }> = [
    { href: '/', label: 'New game', match: (p) => p === '/' },
    {
      href: '/projects',
      label: 'My projects',
      match: (p) => p === '/projects' || p.startsWith('/projects/'),
    },
    { href: '/hub', label: 'Community hub', match: (p) => p.startsWith('/hub') },
  ];

  return (
    <aside
      className={`safe-top safe-left fixed inset-y-0 left-0 z-50 flex h-dvh w-[232px] shrink-0 flex-col border-r border-hairline bg-chrome transition-transform duration-200 md:sticky md:top-0 md:z-40 md:translate-x-0 ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      {/* Brand */}
      <Link
        href="/"
        onClick={onNavigate}
        className="flex h-[60px] items-center gap-2.5 border-b border-hairline px-5 text-ink transition-colors hover:text-white"
      >
        <BrandMark size={26} className="flex-shrink-0" />
        <Wordmark className="text-[15px]" />
      </Link>

      {/* Primary nav */}
      <nav className="flex flex-col gap-0.5 px-3 py-5">
        <div className="type-label-xs px-2.5 pb-2.5 text-ink-4">Workspace</div>
        {navItems.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex items-center gap-3 border-l-2 px-2.5 py-2.5 text-sm transition-colors ${
                active
                  ? 'border-signal bg-raised font-semibold text-ink'
                  : 'border-transparent text-ink-3 hover:bg-surface hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Footer — credits + account */}
      <div className="border-t border-hairline px-5 py-4">
        {handle ? (
          <div className="flex flex-col">
            {balance !== null && (
              <div className="mb-4" title={`${balance} credits remaining`}>
                <div className="type-label-xs text-ink-4">Credits</div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="font-mono text-xl font-bold text-ink">
                    {balance.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
            <Link
              href={`/u/${handle}`}
              onClick={onNavigate}
              className="-mx-2.5 flex items-center gap-2.5 border-l-2 border-transparent px-2.5 py-2 text-[13px] text-ink-3 transition-colors hover:bg-surface hover:text-ink"
            >
              <span className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center border border-edge font-mono text-[10px] text-signal">
                {handle.charAt(0).toUpperCase()}
              </span>
              <span className="truncate">@{handle}</span>
            </Link>
            <Link
              href="/settings"
              onClick={onNavigate}
              className="-mx-2.5 flex items-center gap-2.5 border-l-2 border-transparent px-2.5 py-2 text-[13px] text-ink-3 transition-colors hover:bg-surface hover:text-ink"
            >
              Settings
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              className="-mx-2.5 flex items-center gap-2.5 border-l-2 border-transparent px-2.5 py-2 text-left text-[13px] text-ink-4 transition-colors hover:bg-surface hover:text-fail"
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Link
              href="/auth/login"
              onClick={onNavigate}
              className="w-full border border-edge px-3 py-2 text-center text-sm font-semibold text-ink transition-colors hover:border-signal hover:text-signal"
            >
              Sign in
            </Link>
            <Link
              href="/auth/register"
              onClick={onNavigate}
              className="w-full bg-signal px-3 py-2 text-center text-sm font-bold text-chrome transition-colors hover:bg-signal-bright"
            >
              Sign up
            </Link>
          </div>
        )}
      </div>
    </aside>
  );
}
