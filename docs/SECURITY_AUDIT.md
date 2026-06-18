# Pre-launch security & correctness audit — Playforge

**Date:** 2026-06-18
**Scope:** Full monorepo audit across six risk surfaces (SSRF, path traversal, API
auth/authz, CSP/iframe isolation, untrusted content/injection, runtime
correctness), driven by the threat model in `CLAUDE.md`. Every fix below ships
with regression tests; `pnpm test` and `pnpm typecheck` are green.

## Headline assessment

The codebase was already well-hardened. The canonical SSRF guard, the two-layer
path containment, per-route + per-repo ownership checks, atomic credit
reservation, the locked game CSP, React auto-escaping, and the prompt-injection
envelope for remix/fetched content were all in place and correct. No critical
unauthenticated-data-exposure, IDOR, SQLi, or stored-XSS was found. The fixes
here close residual gaps and one production-stability bug (an SSE Redis
connection leak).

---

## Fixed in this pass (with tests)

### Correctness / reliability
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| C1 | **Critical** | SSE relay discarded the bus `Unsubscribe`; each ended stream leaked a dedicated Redis reader connection forever (RedisEventBus), climbing until Redis refuses connections. | `finish()` now captures and calls `unsubscribe()` on every close path (incl. synchronous in-memory replay). `services/api/src/server.ts` + test. |
| C2 | High | `JSON.parse` of Redis stream entries had no guard; one corrupt entry rejected the whole `subscribe()` replay or killed the live XREAD loop, silently stranding the stream. | `safeParseStreamData` logs + skips bad entries. `packages/bus/src/index.ts` + test. |
| C3 | High | Fire-and-forget `enqueue`/`publish` had no `.catch`; a Redis blip after the credit reservation stranded a **paid** run in `queued` until the 30-min reaper, with an unhandled rejection. | Production `queue.add` now refunds + marks failed on error (idempotent); `publish` is `.catch`-guarded; both services register an `unhandledRejection` handler. |
| H1 | High | Run token ceiling compared a **single turn's** usage to the **whole-run** budget, so a many-turn run could spend a large multiple of the cap unchecked. | Accumulate usage across `turn_end` events. `services/worker/src/run-generation.ts` + test. |
| H3 | Medium | SSE `JSON.stringify(payload)` could throw on an unserializable event, leaving the stream open with timers armed. | Wrapped in try/catch; drop the bad frame. |
| M1 | Medium | Env ints parsed with bare `Number()`; a typo → `NaN` silently broke `concurrency`, `setInterval` (0ms hot loop), and disabled the token ceiling (`used > NaN` is always false). | `parsePositiveIntEnv` validates and falls back. Both services + test. |
| M3 | Low | Swallowed presence-broadcast error (`.catch(() => {})`). | Logged. |

### SSRF (`read_url` / server fetch)
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| H1 | High | Body read via `res.text()` buffered the **entire** decoded response before the char cap — a multi-GB body or a gzip decompression bomb could OOM a shared worker. | Stream the body with a hard `READ_URL_MAX_BYTES` (5 MB) cap; cancel the stream when exceeded. `packages/core/src/tools/read-url.ts` + test. |
| M1 | Medium | The SSRF guard ignored the URL port, allowing reach to internal services (Redis 6379, Postgres 5432, …) on a public-but-multihomed host. | Port allowlist (`''`/80/443/8080/8443) in `assertSafeUrlString`. `packages/shared/src/ssrf.ts` + test. |

### Path traversal
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| — | Defense-in-depth | `WorkingTree` mutators (`view`/`strReplace`/`insert`/`patch`) trusted the caller for path safety; the class doc claimed it self-enforced. | `assertSafeBundlePath` added to `view` + `requireFile`. |
| — | Low | `generate_image_asset` wrote a model-supplied `filenameHint` with only the storage guard (not the two-independent-checks property). | `assertSafeToolPath` added before the write. |
| — | Low | Tool-layer guard accepted `.` segments + non-NFC paths that the storage layer rejects → surprising late failure at persist. | Aligned `assertSafeToolPath` to reject `.`/empty segments + non-NFC. + tests. |

### CSP / iframe isolation
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| C2 | **Critical (interim)** | The public play iframe used `allow-scripts` **and** `allow-same-origin`; with all games on one origin (see C1-infra), a hostile game could read another game's `localStorage`/cookies. | Dropped `allow-same-origin` from the public play iframe → opaque origin. The score bridge (postMessage-to-parent) is unaffected. `apps/web/.../play-client.tsx`. |
| H1–H4 | High | Four inbound `message` listeners (`game:setParams`, play-page score, tweaks-bridge, hmr-patcher) had no source/origin check — a foreign frame could drive gameplay, spoof scores, or run code in a preview. | Each now rejects messages from any real window that isn't the host parent / game iframe. Runtime snippets + play-client; foreign-source regression test added. |
| M2 | Medium | Run-preview route hardcoded `frame-ancestors *`. | Now uses the configured `allowedFrameOrigins`, so prod can lock embedding. |
| M3 | Medium | Browser-worker egress allowlisted `cdn.jsdelivr.net` host-only; jsdelivr proxies arbitrary npm + GitHub repos (`/gh/…`), an arbitrary-code-load channel. | Pinned to `/npm/three@` + `/npm/phaser@` path prefixes. + test. |

### Identity / content (Hub)
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| — | High | Handle registration had no reserved-name / normalization protection → impersonation (`admin`, `support`, `ad_min`→admin). | NFKC-fold before strip; reject leading/trailing separators; deny reserved handles incl. separator-collapsed forms (409). |
| — | Medium | Creators could rate/like their **own** game (vote-stuffing; ratings drive ranking). | `cannot_rate_own` / `cannot_like_own`. + test. |
| — | Medium | Project name (= published title in `<head>`/OG) and comment body were uncapped. | Caps: name ≤120, comment ≤2000. + test. |
| M3 | Medium | `remixOfProjectId` accepted verbatim on direct create → forged "Remix of <popular game>" lineage. | Validates the parent exists and is non-private. + test. |
| M1 | Medium | Project chat history (every prompt) was readable by any user for a non-private project. | Chat is now owner-only regardless of game visibility. + test. |
| — | Low | Reply `parentCommentId` not checked against the game. | Validated to belong to the same game. |

### API hardening
| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| H2 | High | `trustProxy` unset → behind Cloudflare/edge, `req.ip` was the proxy, collapsing every per-IP control. | `Fastify({ trustProxy: true })`. |
| H3 | High | `GET /v1/admin/queue-depth` was unauthenticated, leaking live queue backlog under an `/admin/` path. | Gated behind `requireAdmin` (fails closed). + test. |

### Lint / build hygiene
- Excluded vendored third-party bundles (`**/vendor/**`: babel/react UMD, design-mode JSX leftovers) from lint — they were **3,592 of 4,335** errors (83%), all minified-JS noise, not our code.
- Aligned the Biome config to the codebase's deliberate, idiomatic strict-TS style: `useLiteralKeys` and `noNonNullAssertion` off (their fixes are *unsafe* — they change runtime semantics — and the style is intentional with `noUncheckedIndexedAccess`).
- Applied behavior-safe mechanical fixes (import-type, template literals, optional chains, `Math.pow`→`**`); **typecheck caught two `useOptionalChain` regressions** (`boolean|undefined`) which were corrected.
- Net: **4,335 → 163** lint findings (−96%). The residual 163 are frontend a11y/hygiene in `apps/web` — see backlog below.

---

## Residual — requires live infra or product decisions (NOT fixed here)

These are real and tracked, but need deployment infrastructure or carry
integration-test risk that can't be validated in a hermetic checkout. They
should be closed before, or as part of, the public launch.

1. **DNS-rebinding pin (SSRF, Critical).** `assertSafeUrl` validates the
   resolved IP, but `fetch()` re-resolves independently — a low-TTL attacker
   record can flip public→private between check and connect, reaching cloud
   metadata. The fix is to pin the connection to the validated IP at connect
   time (an `undici` `Agent` with a `connect.lookup` returning only the
   validated address, applied to every redirect hop). This needs the `undici`
   dependency + real-network integration testing; the misleading "rebind
   handled" comment has been corrected to flag the gap. **Do before public
   launch.**

2. **Per-project origin isolation (CSP C1, Critical).** The threat model
   requires `*.games.<brand>.app` per-project subdomains. Currently all games
   share one origin; dropping `allow-same-origin` (done) is the interim
   mitigation, but true isolation needs hostname-based routing on the edge/API.

3. **Redis-backed rate limiting (API H1, High).** Auth / password-reset / abuse
   throttles are in-process `Map`s — bypassable across instances and wiped on
   deploy. Move counters to Redis (already provisioned for the bus/queue).

4. **Concurrent-run-per-user TOCTOU (API H2, High).** `countActiveByUser()` +
   `create()` aren't atomic (unlike the credit reservation right below them).
   Wrap both in the same `pg_advisory_xact_lock(userId)` transaction.

5. **Per-tenant browser isolation (CSP M4, Medium).** One Chromium process is
   shared across tenants' untrusted games; a renderer escape crosses tenant
   boundaries. Use one browser per tenant/job + hardening launch args.

6. **Shared zod at the API boundary (auth M4, Medium).** Routes hand-roll
   validation instead of importing the `@playforge/shared` schemas — the root
   cause of gaps like the `remixOfProjectId` one. Attach the shared schemas via
   a Fastify type provider.

7. **Motion / Remotion mode (codesign carryover).** The design-mode subsystem
   was fully removed (see below), but the separate Remotion/motion-mode code
   (`choose-remotion-style`, `motionMode`, `isMotionMode`, `renderMotionPreview`)
   remains. `CLAUDE.md` drops motion mode too; it's dead-in-cloud (the worker
   never sets `motionMode`). Remove in a follow-up pass for full "no codesign
   trace" compliance.

## Resolved after the initial audit (non-security pass)

- **Lint is now green** (`pnpm lint` exits 0). 4,335 → 0: excluded vendored
  bundles, aligned config to the codebase's intentional strict-TS style
  (`useLiteralKeys`/`noNonNullAssertion`), formatted the repo, fixed the
  frontend a11y findings in `apps/web` (button types, decorative-SVG `aria-hidden`,
  `<output>` for status regions, label associations) and the remaining
  hygiene findings (game-skills `??=`/local-const/for-of), with justified
  `// biome-ignore` only for genuine false-positives/deliberate cases
  (exhaustive-deps, static-skeleton keys, the awaitable Drizzle test mock, the
  raw-WebSocket `any`, the closure-captured `let`). Typecheck 15/15, tests green.

- **Design-mode (codesign) subsystem removed.** Deleted
  `packages/core/src/design-skills/` and `frames/` (12 + 5 `.jsx`),
  `tools/design-library.ts` + `read-design-system.ts`, and
  `packages/runtime/vendor/{design-canvas,ios-frame}.jsx`; removed the
  `list_design_skills`/`view_design_skill`/`view_frame`/`read_design_system`
  tool registrations + design-library prompt sections from `agent.ts`, the
  `index.ts` exports, and the obsolete tests. Notably, `runtime/index.ts` was
  injecting `ios-frame`/`design-canvas` components into **every** preview iframe
  — a live visual codesign trace — now removed. A repo-wide grep for
  `design-skills|design-library|design-canvas|ios-frame|list_design_skills|
  view_design_skill|read_design_system|FRAME_TEMPLATES|IOSDevice|DesignCanvas`
  is empty. Full typecheck + test suite green.
