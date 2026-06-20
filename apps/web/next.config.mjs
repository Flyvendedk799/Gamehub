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
};

export default nextConfig;
