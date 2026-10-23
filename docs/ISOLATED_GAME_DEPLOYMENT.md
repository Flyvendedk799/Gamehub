# Deploy isolated previews and verified publication

The implementation is fail-closed. Production API startup requires `GAME_BASE_URL` and `PREVIEW_SIGNING_SECRET` (at least 32 random characters). Apply `packages/db/drizzle/0019_game_quality.sql` before starting the updated API/workers. It is additive and idempotent. Existing snapshots remain unverified; do not backfill synthetic passing evidence.

Use a separate game hostname, for example `https://games.example.com`, with wildcard DNS and TLS for `*.games.example.com`. Each project uses `p-<hash>.games.example.com`. The application origin must be different. A separate registrable domain provides additional cookie isolation; never use parent-domain session cookies on game domains.

**One-level mode (free Cloudflare Universal SSL).** A free Universal SSL certificate covers only the apex and one wildcard label (`*.example.com`), so `p-<hash>.games.example.com` fails the TLS handshake at the edge. When no Advanced Certificate or separate game domain is available, set `GAME_BASE_URL` to the application origin itself (`https://example.com`): projects then live at `p-<hash>.example.com`, each still on its own origin. In this mode the bare application hostname keeps serving application routes and only `p-<hash>` subdomains are treated as game hosts. The application session cookie must stay host-only (no `Domain=` attribute) so it is never sent to game hosts. Prefer a separate registrable domain when you can.

Route game hosts directly to the API, preserving the incoming **Host** header. Only signed `/game-preview/:ticket` and public `/v1/play/:slug` GET routes are served there; application API routes return 404. Do not send wildcard game hosts to the Next.js shell. Do not rewrite the Host to the application domain. The API serves a restrictive response CSP including `sandbox allow-scripts allow-pointer-lock`, even for direct tabs.

For ServerHoster, configure the wildcard TLS/tunnel ingress to the existing loopback API port `127.0.0.1:3191`. The web application keeps its existing route. Configure both environment variables in the encrypted service environment and redeploy only the affected application services. No DNS, tunnel, production database or running service was changed by the local implementation.

For the standalone Caddy deployment, terminate wildcard TLS at a properly configured edge/DNS-challenge proxy and route the game host to the API. The supplied Caddy image does not include a DNS-provider module, so it cannot obtain wildcard certificates by the HTTP challenge. Do not pretend a same-origin route provides isolation or deploy an HTTP game origin in production.

Keep the signing secret stable across API replicas. Rotating it expires outstanding five-minute preview tickets; reload issues a fresh ticket. The ticket grants read access to one immutable manifest, not an account session. Do not log complete ticket URLs. Configure edge caches to honor `no-store` for previews and revalidation for mutable public slugs.

Smoke test after deployment:

1. Open a private project preview: its iframe URL must use the project game host and contain no session token. Reload and history previews must work.
2. Attempt an application API request on the game host: expect 404. Open a preview ticket on another host: expect 404.
3. Confirm generated code cannot read parent DOM/storage or contact the application API. The local Chromium test covers the served HTML/CSP; repeat through actual DNS, TLS and proxy routing.
4. Build a verified version, then a failing edit. Confirm the verified preview remains available and the failed version is labelled a draft in history/chat.
5. Publish a verified game, then make browser verification unavailable and try publishing an edit. Expect rejection and the previous public bundle to remain live. Restore verification and publish again.

Publication tests the final exported HTML for boot and stored gameplay predicates before promotion. PostgreSQL locks the project and publication rows during promotion and checks the expected snapshot, preventing stale candidates or moderation races from replacing the public version. Thumbnail capture is supplementary and does not substitute for gameplay evidence.
