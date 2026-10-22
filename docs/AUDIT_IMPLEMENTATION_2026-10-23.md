# Audit implementation — 23 October 2026

This follows the ordered recommendations in [the original audit](PRODUCT_ENGINE_AUDIT_2026-10-22.md). Changes are local and uncommitted. No production deployment, paid generation or provider benchmark was performed. The user will run the benchmark.

## Implemented

| Area | Change and evidence |
|---|---|
| Preview isolation | Per-project game hosts, short-lived signed manifest tickets, response CSP sandbox and opaque iframe origins. Preview URLs no longer carry account tokens. Game hosts reject application API routes. Tests cover ownership, ticket tampering/expiry, wrong hosts and real Chromium parent/storage/network isolation. |
| Truthful readiness | Versioned quality records belong to immutable file hashes. Boot and gameplay predicates must pass; forced acceptance, exhausted repair and missing evidence cannot become verified. Persistence must finish before completion is announced. UI distinguishes verified, draft, paused and failed states. |
| Recovery | Failed edits retain the previous verified preview. History identifies verified/draft snapshots and supports explicit draft previews and restoration. |
| Verified publishing | Verify the final exported HTML and both original/edit gameplay contracts before public promotion. Missing, failed or unavailable verification rejects publication without replacing the previous bundle. Database promotion checks current snapshot and moderation state under row locks. |
| Shared engine | Canonical and inlined prompts agree with the modular starter. New cloud builds select Phaser or Three; existing Canvas projects remain editable. Persistent creative briefs carry the hook, fantasy, visual direction, feedback and exclusions into later edits and critique. |
| Provider consistency | Agent and completion paths use one registry-backed capability profile. Explicit wire/endpoint choices survive resolution. Queue and local critique share routing and refreshed credentials. Unknown models use conservative limits. Adapter tests are contract evidence, not proof of equal generated-game quality. |
| Creator experience | Shared run-state derivation, cancellation-safe interview lifecycle with a deadline/build-now escape, preserved chat reading position with a new-updates button, simpler 2D/3D choices and truthful draft copy. Homepage galleries link to real live games with captured thumbnails, varying genres; no fabricated examples appear if the Hub is empty or unavailable. |
| Evidence | Final title/play captures accompany quality records when available. Audio evaluation requires affirmative audibility evidence. Offline benchmark preparation creates 126 randomized cases, fixed edits/recovery steps and evidence requirements without invoking providers. |
| Baseline | React typing and locale-sensitive assertions fixed; Windows line endings normalized through repository attributes; lint debt addressed. |

## Validation

- `pnpm lint`: passes, 782 checked files.
- `pnpm typecheck`: passes, all 15 workspace tasks.
- `pnpm exec turbo run test --concurrency=1`: passes, all 15 workspace tasks (12 reused valid cache results); 3,526 tests passed and one opt-in live test skipped. Browser worker: 36; API: 312; worker: 209; providers: 295; web: 328; core: 1,463 passed.
- Creator lifecycle/gallery DOM tests: 6 passed. Queue tests: 8 passed, including persistence failure never announcing success.
- Historical `pnpm eval:games --no-write`: 6/14 recorded fixtures pass; eight recordings remain missing. These are old recordings, not a new outcome baseline.

Windows Chromium process shutdown exceeded existing test deadlines during verification. Only the Windows crash/relaunch test and shutdown-hook allowances were extended; production browser code and per-game deadlines are unchanged. The isolation test uses real Chromium against actual API-generated HTML/CSP with mocked network routing; it does not prove production DNS/proxy configuration.

## Required before the user's benchmark

Follow [the deployment checklist](ISOLATED_GAME_DEPLOYMENT.md): additive quality migration, wildcard game DNS/TLS, Host-preserving API ingress, stable signing secret and deployed smoke tests. The updated production API deliberately refuses startup without its isolation configuration. Existing snapshots remain unverified until real checks produce evidence.

Then follow [the benchmark runbook](PROVIDER_PARITY_RUNBOOK.md). The prepared plan is `evals/provider-parity/plan.json`; exact models, budgets and commit must be filled before execution. Keep failures and missing evidence in the results. No provider is certified merely because local adapter tests pass.

## Acceptance that still needs real-world evidence

The audit's deployment-routing criterion, fresh 14-brief outcome baseline, blind human comparison of game feel/originality, and complete desktop/touch/accessibility journeys are not satisfied by these local code changes. Persistent briefs and multi-moment captures enable that work; they do not establish a measured improvement. The gallery uses published community captures rather than a newly generated, curated showcase. Human review and the user's runs must establish the launch thresholds before claiming the product or providers meet them.
