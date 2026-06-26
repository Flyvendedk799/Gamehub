'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import Sidebar from '@/components/Sidebar';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * App chrome. Renders the persistent navigation Sidebar alongside the page on
 * every dashboard surface, and gets out of the way on immersive / chromeless
 * views where a nav rail would intrude:
 *   - /auth/*            — login / register
 *   - /onboarding        — first-run setup
 *   - /projects/:id      — the full-screen game builder/editor, which embeds its
 *                          own Sidebar instance (in-flow rail + hamburger drawer)
 *                          so the main nav is present there too, without the
 *                          mobile top bar colliding with the editor's own chrome
 *   - /p/:slug           — the public, shareable/embeddable play page
 *
 * Responsive: at md+ the sidebar is an in-flow sticky rail. Below md it collapses
 * to an off-canvas drawer, opened by a hamburger in a mobile top bar and dismissed
 * by a backdrop tap or any navigation.
 */
function isChromeless(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/onboarding') ||
    pathname.startsWith('/projects/') || // the editor (/projects/:id); the list (/projects) keeps the rail
    pathname.startsWith('/p/')
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile drawer on any route change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger — re-run on navigation to close the drawer, even though it's not read in the body.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (isChromeless(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar open={open} onNavigate={() => setOpen(false)} />

      {/* Mobile drawer backdrop */}
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}

      <div className="flex flex-1 min-w-0 flex-col">
        {/* Mobile top bar — hamburger + brand (the sidebar carries it on desktop) */}
        <header className="md:hidden safe-top sticky top-0 z-30 flex items-center gap-3 h-14 px-4 border-b border-[#1a1a1a] bg-[#0a0a0a]/90 backdrop-blur">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="p-3 -ml-3 tap-target inline-flex items-center justify-center text-[#a1a1aa] hover:text-[#f4f4f5] rounded-lg hover:bg-[#161616] transition-all"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          <Link href="/" className="flex items-center gap-2 text-[#f4f4f5]">
            <BrandMark size={22} className="flex-shrink-0" />
            <Wordmark className="text-sm font-semibold" />
          </Link>
        </header>

        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
