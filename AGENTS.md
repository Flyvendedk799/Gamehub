# Playforge — engineering constraints

> **Working codename: Playforge.** A final brand is a Phase 0 deliverable; once chosen, do a global rename of the `@playforge/*` namespace, the repo, and all user-facing strings. The product must be **unrecognizable from open-codesign / PrivateClaudesign** — no lexical or visual trace of "codesign".

## What this is
A **cloud-native AI game builder** ("Lovable for games"). A user describes a game in natural language; a server-side AI agent builds a real, playable **web game** (Phaser 2D / Three.js 3D) that runs in the browser. Projects live 100% in the cloud tied to a user account. Every game gets an instant shareable play URL, and a community **Hub** lets people publish, discover, play, rate, and remix games. Full plan: `~/.Codex/plans/deep-meandering-bunny.md`.

## Origin of the code
Foundational packages are **re-platformed IP** lifted from `~/PrivateClaudesign` (an Electron desktop AI-builder) and rebranded. The agent loop, genre/spec guardrails, playtest harness, Phaser+Three runtime adapters, prompts, and exporters carry forward; the Electron/desktop shell, local-SQLite, non-game modes (design/SVG/motion), and pygame/godot/unity engines are dropped.

## Cloud constraints (these INVERT the desktop base's rules)
- **Hosted + multi-tenant**, not local-first. Data lives in Postgres + object storage, scoped per user.
- **Platform LLM keys are allowed** (metered as credits); BYOK is an option, not the only mode.
- **Server-side generation**: the agent runs in queue workers, never on the user's machine. Stream to the browser over SSE.
- **Untrusted-code security is paramount**: generated games are untrusted and run in users' browsers and at public URLs. Origin isolation (`*.games.<brand>.app`, per-project subdomain) + locked CSP (`connect-src 'self'`) + isolated browser-worker execution are non-negotiable. See plan §7 threat model.
- **New cloud-only safety work**: SSRF-harden any server-side `read_url`/asset fetch (block RFC1918/link-local/169.254.169.254); path-traversal validation on file writes; treat remix-imported content as untrusted (prompt-injection).

## Engines (cloud scope)
**Phaser 3 (2D) + Three.js (3D) only.** Both run instantly in a sandboxed iframe with CDN-pinned bootstraps and a `window.__game` postMessage bridge. Pygame/Godot/Unity are out of scope.

## Stack
pnpm + Turbo monorepo. TypeScript everywhere. Next.js (App Router) frontend; Fastify API; Node worker services; Postgres 16; Redis + BullMQ; object storage (S3/R2); Clerk auth; Stripe billing; Playwright browser-worker pool; Cloudflare edge. Tests: Vitest (unit) + Playwright (e2e). Lint/format: Biome. Default to the latest Codex models for generation.

## Conventions
- Strict TS (`strict`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). No `any`.
- Shared zod schemas live in `@playforge/shared` and are imported by frontend, API, and workers alike.
- Schema-version anything persisted to disk/DB; migrations additive.
- At least one test per feature. Keep lifted tests green through every rename/refactor.
- `pnpm test` / `pnpm typecheck` / `pnpm lint` run via Turbo across the workspace.

## Layout
- `packages/shared` — domain zod schemas (game-spec, snapshot, abort-kind, pricing, error-codes, …). **Lifted + green (286 tests).**
- `packages/*` — re-platformed engine/agent/runtime/exporter packages (incoming).
- `services/*` — API, generation worker, browser worker (incoming).
- `apps/*` — Next.js web app (incoming).
