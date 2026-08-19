# Playforge *(working codename)*

Cloud-native AI game builder — describe a game in natural language, get a real, playable web game (Phaser 2D / Three.js 3D) in your browser, publish it to an instant shareable URL, and remix others' games in a community hub.

> Working codename only; final brand TBD. See `CLAUDE.md` and `~/.claude/plans/deep-meandering-bunny.md`.

## Status
**Phase 0 — cloud spine (in progress).** 12 packages, 1615 tests green, typecheck clean.
- ✅ Monorepo (pnpm + Turbo + Biome + strict TS)
- ✅ `@playforge/shared` — domain schemas re-platformed from the desktop base (286 tests)
- ✅ `@playforge/runtime` — Phaser + Three preview bootstraps + `__game` bridge (148 tests)
- ✅ `@playforge/exporters` — web-games-only publish bundles: game-html/zip/markdown (46 tests)
- ✅ `@playforge/db` — Drizzle schema, 16 tables, clean SQL migration (8 tests)
- ✅ `@playforge/storage` — content-addressed blobs + snapshot manifests + path guard (7 tests)
- ✅ `@playforge/agent-core` (+ i18n/artifacts/providers/templates) — the generation
  brain: `generateViaAgent` loop, game tools, inlined prompts, multi-provider gateway (1102 tests)
- ✅ `@playforge/worker` — `WorkingTree` fs adapter + `runGeneration` orchestrator;
  offline E2E builds a red-square game (agent→fs→snapshot→stream), no infra/keys (13 tests)
- ✅ `@playforge/api` — Fastify: health + authenticated projects CRUD over a repo
  interface + pluggable auth (5 inject() tests) (5 tests)
- ✅ **Game Jam (party mode)** — 2–8 people join a room from their phones with a
  4-character code (guests need no account), answer prompt cards round by round,
  hype each other's ideas, and the whole pile compiles into ONE brief that builds
  a local-multiplayer couch co-op game the room plays together. Shared schemas +
  compiler in `@playforge/shared/game-jam`, `jams`/`jam_players`/`jam_answers`/
  `jam_votes` tables (migration 0017), `/v1/jams/*` REST + room WebSocket, and
  `/jam` + `/jam/:code` in the web app (117 tests)
- ⬜ **Needs live infra** (Postgres + Redis + provider key): Drizzle-backed repo,
  BullMQ consumer, Redis pub/sub → SSE relay, Clerk auth, live red-square run + preview

## Develop
```bash
pnpm install
pnpm test        # vitest across the workspace
pnpm typecheck
pnpm lint
```

Requires Node ≥ 22 and pnpm 9.
