'use client';

import Sidebar from '@/components/Sidebar';
import { usePathname } from 'next/navigation';

/**
 * App chrome. Renders the persistent navigation Sidebar alongside the page on
 * every dashboard surface, and gets out of the way on immersive / chromeless
 * views where a nav rail would intrude:
 *   - /auth/*            — login / register
 *   - /onboarding        — first-run setup
 *   - /projects/:id      — the full-screen game builder/editor
 *   - /p/:slug           — the public, shareable/embeddable play page
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

  if (isChromeless(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
