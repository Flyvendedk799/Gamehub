import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { authRedirectTarget, middleware } from './middleware';

function request(path: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token !== undefined) headers.set('cookie', `pf_token=${token}`);
  return new NextRequest(`http://localhost:3004${path}`, { headers });
}

describe('authRedirectTarget', () => {
  it('sends anonymous visitors from protected pages to the login form', () => {
    expect(authRedirectTarget('/projects', false)).toBe('/auth/login?next=%2Fprojects');
    expect(authRedirectTarget('/settings', false)).toBe('/auth/login?next=%2Fsettings');
    expect(authRedirectTarget('/onboarding', false)).toBe('/auth/login?next=%2Fonboarding');
  });

  it('leaves the login and register forms reachable when a session cookie is present', () => {
    expect(authRedirectTarget('/auth/login', true)).toBeNull();
    expect(authRedirectTarget('/auth/register', true)).toBeNull();
    expect(authRedirectTarget('/auth/login', false)).toBeNull();
  });

  it('does not gate the public homepage', () => {
    expect(authRedirectTarget('/', false)).toBeNull();
    expect(authRedirectTarget('/', true)).toBeNull();
  });
});

describe('middleware', () => {
  it('does not redirect /auth/login when a stale session cookie is set', () => {
    const res = middleware(request('/auth/login', 'stale-session-token'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects an anonymous /projects visit to login with next set', () => {
    const res = middleware(request('/projects/abc'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3004/auth/login?next=%2Fprojects%2Fabc',
    );
  });
});
