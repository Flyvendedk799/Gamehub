import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PROTECTED_PREFIXES = ['/projects', '/settings', '/onboarding'];

/**
 * Where an unauthenticated request should land, or null to continue.
 *
 * A `pf_token` cookie is not a live session — it survives logout glitches,
 * cleared site data, and expired server sessions for up to 30 days. Treating
 * it as "already signed in" and bouncing `/auth/login` back to `/` made the
 * sign-in form unreachable: the homepage still offered Sign in, and that link
 * came straight back here.
 */
export function authRedirectTarget(pathname: string, hasSessionCookie: boolean): string | null {
  if (!hasSessionCookie && PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return `/auth/login?next=${encodeURIComponent(pathname)}`;
  }
  return null;
}

export function middleware(request: NextRequest) {
  const token = request.cookies.get('pf_token')?.value;
  const target = authRedirectTarget(request.nextUrl.pathname, Boolean(token));
  if (target) {
    return NextResponse.redirect(new URL(target, request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
