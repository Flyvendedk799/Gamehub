# Playforge — Improvement Backlog

_Synthesized from 106 adversarially-verified findings. Scope is strictly **buildable-now, in-repo** work. Stripe billing, real `*.games.<brand>.app` origin isolation, password reset, and the brand rename are deferred (external services) and intentionally excluded. Ranking weights impact on the 5 core principles × confidence ÷ effort, with **security** and the **one-prompt-to-playable** core loop weighted highest._

---

## 1. Themes

### A. Untrusted-Code Execution & Origin Isolation (in-repo half)
The `browser-worker` runs hostile game HTML in a shared Chromium with **no network lockdown, no per-job isolation, no kill switch, and zero tests** — server-side SSRF/exfil from inside the renderer. The served-game CSP advertises `connect-src 'none'` but is bypassable via `img-src *`/`media-src *`. Iframes use `allow-same-origin`, and the `__game`/tweak bridge broadcasts to `'*'` and trusts any inbound message origin. This is the in-repo, buildable-now half of Principle 2's non-negotiable isolation mandate.

### B. SSRF Hardening Across Server-Side Fetches
`read_url`, the providers `baseUrl` path, and the exporter engine fetch all fetch attacker/model-influenced URLs with no shared guard. The existing `assertSafeUrl` is worker-local, untested, and misses IPv6 ULA/link-local and IPv4-mapped addresses. **Fix:** one shared `assertSafeUrl` in `@playforge/shared`, applied everywhere, with tests.

### C. Credit Metering Integrity & Concurrency
Credits are debited only post-success in the worker — no atomic reservation, no idempotency key, a non-locking `SUM` balance read, and a **free in-process fallback path**. The whole `100 free / 10 per run` invariant is racy, bypassable, and untested. The token ceiling is also cosmetic (`AbortController` created, `.abort()` never called).

### D. Auth, Session & Admin Hardening
Unauthenticated WS collab/presence routes; admin routes fail **open** when `ADMIN_TOKEN` is unset; per-process rate-limiting with no `trustProxy` (global self-DoS behind the proxy); session tokens in URLs and JS-readable storage; a `sessions` unique index that 500s on concurrent login.

### E. Engine Source-of-Truth & the One-Prompt-to-Playable Loop
`project.engine` is hardcoded `'phaser'` at creation and **never updated from `choose_engine`**, so every 3D game ships with the Phaser bootstrap and is unplayable at its share URL. SSE streams don't reconnect; terminal-event handling races; resume hydration mislabels user turns.

### F. Worker Data Integrity & Run Lifecycle
Post-agent DB writes are non-transactional with client-side `MAX()+1` seq under `concurrency=2`: colliding seq corrupts the version timeline or strands a completed run as `'failed'` and re-runs it (double LLM cost). No reaper closes orphaned `'running'` runs / SSE streams.

### G. De-Desktop: Remove Non-Web Engines & the `codesign` Protocol
`pygame`/`godot`/`unity` survived the re-platform across `choose_engine`, the system prompt, engine guides, the runtime adapter registry, shared schemas, exporters, and worker validators — the agent can pick `pygame` for a "retro arcade" prompt and emit `main.py` the browser can't boot. The `codesign:*` wire protocol, `BRAND`, `CodesignError`, and the React/Babel design-canvas runtime also persist (Principle 5).

### H. Hub Integrity, Moderation & Abuse Controls
Remix copies the **live mutable HEAD** (leaking unpublished edits); `autoMod` detects but never gates; the report endpoint trusts a client-supplied `userId` and is unthrottled; play-count is trivially gameable; removed bundles stay fetchable via `/v1/blobs`; `/v1/users/:handle` is broken (handle-vs-id).

### I. Shared Schemas, Type-Safety & Contract Drift
Frontend opts out of strict TS, hand-duplicates wire types, and casts `res.json()` with no validation; `@playforge/shared` zod isn't imported by the client; the pricing table is **3× wrong for Opus** and missing the default model; `GameSpec`/patch aren't strict and can't delete features.

### J. Storage Integrity & Content-Addressing
`putBlob` returns `blobs/<hash>` but the blob route + `getBlob` assume a bare hash → **published thumbnails 404**; reads don't verify hashes; LocalFs writes aren't atomic; `readManifest` path-parses with no validation; the path guard misses control chars / non-NFC. Storage read paths are untested.

### K. Frontend Test Seam, Resilience & UX Feedback
`apps/web` has zero test tooling despite load-bearing pure logic (varint codec, history hydration); pervasive silent `.catch(() => {})` hides credit-exhaustion and load failures; no CSP/security headers on the web tier; a11y gaps; the built Hub search endpoint is never wired to UI.

### L. CI Hygiene & Schema Smoke Tests
The db schema smoke test still asserts the dropped `clerk_user_id` column, so **CI is red now** and the structural drift-guard fails for the wrong reason.

### M. Remix Prompt-Injection & Exporter Robustness
The remix safety prefix is a single dilutable English sentence with no structural fencing of untrusted file content and no test; the single-file exporter inlines via regex string-replace, misses `three/addons` importmap entries and dynamic imports, and never verifies the output boots.

---

## 2. Ranked Backlog

| # | Title | Subsystem | Dim | Sev | Effort |
|---|-------|-----------|-----|-----|--------|
| 1 | Authenticate + ownership-check collab/presence WS routes (close cross-tenant CRDT injection) | api-routes | security | critical | M |
| 2 | SSRF guard on `read_url` + shared `assertSafeUrl` in `@playforge/shared` | core-agent/shared | security | critical | M |
| 3 | Lock down browser-worker network egress (route abort-default, permissions:[], offline) | browser-worker | security | critical | M |
| 4 | Persist agent-chosen engine to project (fix wrong-engine published/played 3D games) | worker/x-goal | correctness | critical | S |
| 5 | Tighten served-game CSP (drop img/media `*` wildcards) + centralize CSP helper | api-routes | security | high | S |
| 6 | Atomic credit reservation at enqueue + idempotent runId-keyed debit + covering index | api-credits/worker | correctness | high | M |
| 7 | Fail admin/moderation routes CLOSED when `ADMIN_TOKEN` unset + constant-time compare | api-routes/hub | security | high | trivial |
| 8 | Fix `schema.test.ts` (email/password_hash, not clerk_user_id) — CI red now | db-schema | test | high | trivial |
| 9 | Transactional worker persistence + row-locked seq + unique (projectId,seq) + orphan reaper | worker/db | correctness | high | M |
| 10 | SSE stream reconnect/resume with backoff + reconnecting UI state | frontend/x-goal | product-ux | high | S |
| 11 | First browser-worker tests (contract verdict, pageerror, boot-timeout, egress-blocked) | browser-worker | test | high | M |
| 12 | Remove non-web engines (pygame/godot/unity) across all packages; drop Unity/Steam tools | core/runtime/shared | goal-align | high | M |
| 13 | Inject hardened CSP into exported single-file HTML; strip author CSP first | exporters | security | high | S |
| 14 | Remix forks published immutable snapshot, not live HEAD (persist+resolve snapshotId) | api-hub | security | high | M |
| 15 | `trustProxy` + Redis-backed rate-limit; fix login key to prevent victim lockout | api-credits | security | high | M |
| 16 | Add apps/web test tooling + first pure-fn tests (varint codec, chat hydration) | frontend/x-tests | test | high | M |
| 17 | Wire `@playforge/shared` zod into `apiFetch`; delete duplicated wire types | frontend/shared | type-safety | medium | M |
| 18 | Enforce token ceiling (accumulate usage → `.abort()`) or rename to maxToolCalls | worker | correctness | medium | M |
| 19 | Gate `autoMod` high-confidence flags to block publish; document CSP as enforcement | api-hub | security | medium | S |
| 20 | Drop `allow-same-origin` from iframes; explicit targetOrigin + inbound origin checks | frontend/runtime | security | medium | S |
| 21 | Move SSE token off URL (short-lived run-scoped ticket; scope query-token to stream route) | frontend/api | security | high | M |
| 22 | Correct Anthropic pricing (Opus 5/25, Haiku 1/5), add opus-4-8 + 1M windows, fix test | shared | correctness | high | S |
| 23 | Default provider/model → Claude + provider-aware asset path (real images on Claude) | worker/x-goal | goal-align | medium | S |
| 24 | Fix `/v1/blobs/:key` key contract (thumbnails 404) + putBlob/getBlob round-trip tests | storage/api-hub | correctness | medium | S |
| 25 | Fence untrusted remixed file content + test that prefix applies for isRemix runs | worker | security | medium | S |
| 26 | Wire existing `/v1/hub/search` endpoint into Hub UI (debounced search + pagination) | x-goal/frontend | product-ux | medium | S |
| 27 | Surface 402/429 + load failures in builder UI; NavBar balance; replace empty catches | x-goal/frontend | product-ux | medium | S |
| 28 | Add credit/auth security-branch tests (429, 402, dummy-hash, worker debit row) | x-tests/api | test | medium | M |
| 29 | Resolve handle→userId in `/v1/users/:handle(/games)` + test (currently always empty) | api-routes | correctness | medium | S |
| 30 | Enforce ownership on `/v1/runs/:id/preview/*` (or validate iframe `?token=`) | api-routes | security | medium | M |
| 31 | Ingress length caps (prompt/comment/password/email) + explicit Fastify `bodyLimit` | api | security | medium | S |
| 32 | Web-tier CSP/security headers (frame-ancestors, nosniff, referrer) + central API URL | frontend | security | medium | S |
| 33 | Per-job browser recycle + relaunch-on-disconnect + per-job deadline kill switch | browser-worker | correctness | high | M |
| 34 | Don't terminate stream on `agent_end`; real `user` message kind (drop `> ` hack) | frontend | correctness | low | S |
| 35 | Throttle/dedup play-count; stop serving removed bundles via `/v1/blobs` (image-only) | api-hub | correctness | low | M |
| 36 | Atomic registration grant (one tx, idempotent) + non-unique `sessions_user_idx` | api-credits/db | correctness | medium | S |
| 37 | Logout-all / revoke-by-user + expired-session sweep; Secure presence-marker cookie | api/frontend | security | medium | M |
| 38 | Rename `codesign:*` protocol (lockstep) + delete React/Babel tweaks-bridge from game path | runtime/frontend | goal-align | medium | M |
| 39 | Rewrite `safety.v1.txt` for game-builder scope (keep injection/IP/abuse rules) | core-agent | goal-align | medium | S |
| 40 | Fence `read_url` fetched content in `<untrusted_fetched_content>` envelope + rule | core-agent | security | medium | S |
| 41 | Strictness pass: GameSpec `.strict()`+deletion; validator network-warn; stars/parent checks | shared/runtime/api | correctness | low | S |
| 42 | Storage integrity: atomic temp+rename, strict readManifest regex, control-char/NFC reject + tests | storage | security | low | S |
| 43 | Exporter robustness: rewrite all importmap entries, complement asset filter, boot check + tests | exporters | correctness | medium | M |
| 44 | Report endpoint: drop `?userId` header injection; throttle; cap reason length | api-hub | security | medium | S |
| 45 | Shared zod for browser-job data (kind, htmlContent.max, clamped timeout, bounded viewport) | browser-worker/shared | type-safety | low | S |
| 46 | Pin/verify engine bytes (SHA-256) at export+publish; strict-semver engineVersion | exporters/runtime | security | low | S |
| 47 | `escapeHtml` gameBaseUrl/pinnedVersion in three/phaser; re-spec gameBaseUrl as https | runtime | security | low | S |
| 48 | Neutralize `read_url` User-Agent; typed auth error mapping + generic 5xx fallback | core/frontend | goal-align | low | trivial |
| 49 | Tool-layer path-traversal assertion in text_editor/list_files; bounded WS shutdown | core/browser-worker | security | low | S |
| 50 | A11y affordances on builder controls (role=switch, aria-label) | frontend | product-ux | low | S |
| 51 | Coalesce streamed deltas into per-turn bubbles with stable keys | frontend | product-ux | low | M |

---

## 3. Quick Wins (trivial/small + high value)

- **#8** Fix `schema.test.ts` (`email`/`password_hash`) — CI is red right now; one-line fix.
- **#7** Fail admin/moderation routes CLOSED when `ADMIN_TOKEN` unset + `timingSafeEqual` — removes a fail-open take-down/restore hole.
- **#5** Drop the `img-src */media-src *` wildcards (CSP) + centralize the helper — restores anti-exfil on every served game.
- **#4** Persist the agent-chosen engine in the worker's `projects` update — fixes the single most magic-breaking bug (3D games shipping with Phaser bootstrap).
- **#31** Ingress length caps + explicit `bodyLimit`, reusing the existing `@playforge/shared` max-length schemas.
- **#13** Inject a hardened meta CSP into exported HTML — makes the false "itch.io-safe / no network access" claim true.
- **#20** Drop `allow-same-origin` from the play/preview iframes + explicit `targetOrigin` — near one-line untrusted-code hardening.
- **#48** Neutralize the `read_url` User-Agent — one-line Principle-5 wire-leak fix.
- **#26** Wire the already-built `/v1/hub/search` into the Hub UI — pure wiring of a paid-for, unexposed capability.

---

## 4. Biggest Risks

1. **Unauthenticated cross-tenant CRDT injection** — anyone guessing a `projectId` joins the collab/presence WS rooms and injects arbitrary Yjs updates into a victim's live doc or enumerates presence; untested (#1, #11).
2. **Server-side SSRF to cloud metadata/internal services** — `read_url` (+ providers `baseUrl`, exporter fetch) fetch model-influenced URLs with no guard, a direct path to `169.254.169.254`/RFC1918 from the queue worker (#2).
3. **Hostile-code execution with full network egress** — the browser-worker runs attacker HTML in a shared Chromium with no isolation and zero tests (#3, #11, #33).
4. **Every 3D game ships broken** — `project.engine` is hardcoded `'phaser'`, so Three.js games are unplayable at their share URL — breaks the headline promise (#4).
5. **Credit metering is bypassable and racy** — post-success-only, non-idempotent debit; free in-process fallback; non-locking SUM; no reservation; untested (#6, #28).
6. **Anti-exfil CSP bypassable on every served game** via `img/media *` wildcards, defeating `connect-src 'none'` (#5).
7. **Moderation fails open** — with `ADMIN_TOKEN` unset, anyone can take down/restore any game and scrape metrics (#7).
8. **Non-transactional worker writes under concurrency=2** — colliding seq corrupts the version timeline or strands a completed run as failed and re-runs at double LLM cost; orphaned runs leave SSE streams open (#9).
9. **Remix leaks unpublished state** — forks the live mutable HEAD instead of the published snapshot (#14).
10. **Zero test infra on the two riskiest surfaces** (browser-worker, apps/web) + red db CI — security-critical logic can regress silently (#8, #11, #16).

---

## 5. Recommended First Batch (execution order, dependency-aware)

1. **#8 — Make CI green** (`schema.test.ts`). A red suite undermines every subsequent test-driven change. _Do first._
2. **#1 — Auth + ownership on collab/presence WS routes.** Highest-severity in-repo security hole; `requireUser` already supports the token path.
3. **#7 — Fail admin/moderation CLOSED + constant-time compare.** Trivial; removes a fail-open take-down/restore hole.
4. **#4 — Persist agent-chosen engine.** Small fix to the single most magic-breaking core-loop bug.
5. **#5 — Tighten served-game CSP.** Restores anti-exfil on every served game; pairs naturally with the WS auth work (same file).
6. **#2 — Shared `assertSafeUrl` + apply to `read_url`/providers/exporter.** Critical SSRF; centralizing unblocks #13 and #46.
7. **#3 — Browser-worker egress lockdown.** Closes the hostile-code execution surface's exfil path.
8. **#11 — First browser-worker tests** (including the egress-blocked assertion that pins #3). Regression net on the highest-risk file.
9. **#6 — Atomic credit reservation + idempotent debit + covering index.** Closes the TOCTOU overspend and free in-process path (after WS/SSRF since it touches the same server/worker files).
10. **#10 — SSE reconnect/resume with backoff.** Delivers Principle-1 "resume across long runs" using the bus replay that already exists; high user-visible payoff.

_Sequencing notes: #1 and #5 touch `services/api/src/server.ts` — batch them. #2 lands the shared SSRF guard that #13/#46 reuse. #3 → #11 (test pins the lockdown). #6 follows the security/server changes to avoid merge churn on `server.ts`/`worker/main.ts`. #9 (transactional worker persistence) is the natural next item after this batch and is a prerequisite for the concurrency assertion in #28._
