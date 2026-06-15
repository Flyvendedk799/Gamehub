# Playforge *(working codename)*

Cloud-native AI game builder — describe a game in natural language, get a real, playable web game (Phaser 2D / Three.js 3D) in your browser, publish it to an instant shareable URL, and remix others' games in a community hub.

> Working codename only; final brand TBD. See `CLAUDE.md` and `~/.claude/plans/deep-meandering-bunny.md`.

## Status
**Phase 0 — cloud spine (in progress).**
- ✅ Monorepo (pnpm + Turbo + Biome + strict TS)
- ✅ `@playforge/shared` — domain schemas re-platformed from the desktop base (286 tests green)
- ⬜ Postgres schema + migrations, object-storage manifest layer
- ⬜ Auth (Clerk) → users
- ⬜ API + generation-worker + browser-worker skeletons
- ⬜ End-to-end "red square" generation with SSE streaming + origin-isolated preview

## Develop
```bash
pnpm install
pnpm test        # vitest across the workspace
pnpm typecheck
pnpm lint
```

Requires Node ≥ 22 and pnpm 9.
