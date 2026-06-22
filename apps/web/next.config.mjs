/** @type {import('next').NextConfig} */

// App-tier security headers (#32). These apply to the Next.js APP shell only.
// The untrusted game iframes are served by the API on a SEPARATE origin and
// carry their own locked CSP — these headers do not touch them. We intentionally
// do NOT set a Content-Security-Policy with frame-src here because the app
// embeds API-origin preview/play iframes; instead we lock down framing OF the
// app shell (clickjacking) and add the cheap, universally-safe hardening headers.
const securityHeaders = [
  // Block MIME-type sniffing.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Don't leak full URLs (which can contain tokens) to cross-origin requests.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Prevent the app shell from being framed by other sites (clickjacking).
  // frame-ancestors 'self' is the modern form; X-Frame-Options is the legacy
  // fallback for older browsers. Neither restricts iframes the app itself
  // embeds (the games), only who may embed the app.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
];

const nextConfig = {
  reactStrictMode: true,
  // Preserve trailing slashes through the /v1 proxy. Next's default redirects
  // `/foo/` → `/foo`, which strips the slash off the API's directory-style
  // preview routes (`/v1/runs/:id/preview/` is served as `/preview/*`) BEFORE the
  // rewrite runs → the API then 404s on the bare `/preview`. Skipping the auto
  // redirect lets the slash pass through verbatim. (The app's own pages are all
  // linked without trailing slashes, so this doesn't affect them.)
  skipTrailingSlashRedirect: true,
  // Workspace packages ship raw TypeScript (with .js import specifiers), so Next
  // must transpile them + resolve their extensions during `next build`.
  transpilePackages: ['@playforge/shared'],
  webpack: (config) => {
    // Resolve ESM-style ".js" import specifiers (e.g. './pricing.js') to their
    // ".ts" source in the workspace packages; ".js" stays as a fallback so
    // ordinary JS modules still resolve.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  // Same-origin API proxy: the browser calls `https://<app-origin>/v1/*` (same
  // origin as the page), and the Next server forwards to the API server-side.
  // This removes the cross-origin/CORS + mixed-content failure that blocked
  // production login (the app and API are different services), without exposing
  // the API on its own public hostname. The target is the API on the same host
  // (override with API_PROXY_TARGET for other layouts).
  // SECURITY follow-up: this also routes the game preview/play iframes
  // (`/v1/projects/:id/preview/*`, `/v1/play/*`) through the app origin — revisit
  // per-project origin isolation (the *.games.<brand> model) before heavy public
  // use; public play iframes are already sandboxed without allow-same-origin.
  async rewrites() {
    const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3191';
    return [{ source: '/v1/:path*', destination: `${apiTarget}/v1/:path*` }];
  },
};

export default nextConfig;
