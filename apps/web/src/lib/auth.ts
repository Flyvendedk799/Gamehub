const TOKEN_KEY = 'pf_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  // Cookie lets Next.js middleware read auth state server-side for redirects.
  document.cookie = `pf_token=${token}; path=/; max-age=${30 * 24 * 60 * 60}; SameSite=Lax`;
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  document.cookie = 'pf_token=; path=/; max-age=0';
}

export function isAuthenticated(): boolean {
  return Boolean(getToken());
}
