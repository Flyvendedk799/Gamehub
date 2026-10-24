# Generation engine audit — 24 October 2026

The target is an open-ended game builder. Quality checks must follow the requested mechanics, including novel combinations, rather than turn every idea into a familiar action game.

## Second pass: production architecture

The first pass left the main build process intact. The second changes how new games are planned, implemented, verified, preserved, and published.

### Requirements drive implementation

New cloud games must declare a versioned `productionPlan` through `declare_game_spec`. The tool and engine-selection gate enforce it. The worker also refuses to give a new game a verified quality assessment when the plan is absent, even if a legacy movement check passes.

The plan records the intended experience, user/design requirements with player outcomes, composable systems and dependencies, 2–4 build milestones, and independent browser scenarios. Shared validation rejects missing implementation/test coverage, duplicate identifiers, unknown references, dependency cycles, systems scheduled before prerequisites, nonexistent assertion frames, missing core/recovery scenarios, and oversized input durations. The vocabulary is open; no predefined combat, economy, actor, scoring or completion model is imposed.

### Build beyond the first playable draft

The generation worker executes later milestones as separate implementation passes on the actual project. Each pass receives the original request, requirements, system integrations and acceptance criteria. The first draft is a foundation, not the end of the build. Later passes explicitly inspect and implement missing mechanics/content/lifecycle rather than simply recommend improvements.

The agent receives the persisted spec, including all scenario state fields, on every subsequent invocation. Previously the getter existed but the system prompt did not carry this design forward. Shared token accounting applies across passes, and each pass receives only the remaining generation wall allowance. Edits to existing games run their retained suite without rebuilding the original milestones.

Requirements and scenarios freeze on declaration for new games, and before verification on edits. They cannot be removed or weakened during build/repair. Tested checkpoints between milestones join the existing best-attempt selection, preserving an earlier stronger implementation if expansion introduces a regression.

### Test the game's rules across independent sessions

`runProductionSuite` drives each declared scenario in a separate browser job. A passing core interaction cannot hide a broken recovery path. Runtime errors, missing debug contracts, incomplete traces, missing fields and failed assertions produce named failures for repair. Unavailable browser jobs produce unavailable evidence, never a passing scenario. These suites do not retry failures until a lucky pass occurs.

Assertions now support string and boolean equality/change alongside numeric comparisons: narrative branches, puzzle completion, selected tools, transport state and discoveries can be checked directly. Ordered comparisons remain numeric and equality never coerces types. The same support is available in custom contracts and edit-intent checks.

Snapshot quality persists the full plan plus per-scenario results, linked to the immutable file hash. Eligibility validation rejects omitted, duplicated, failed or unreadable evidence. Publication replays every production scenario against the exported bundle, plus any edit verification, before promotion. Legacy projects retain their existing verification path.

### Shared rules runtime for both engines

Every new starter includes `src/runtime/session.js`, re-exported from its core module. `createGameSession` provides:

- Immutable serializable rules state and atomic named actions. Rejected/throwing/invalid actions leave state and randomness unchanged.
- Seeded randomness, bounded undo/redo history, branch replacement, reset and versioned snapshot/restore.
- Simulation-driven timers, pause/resume, cancellation on recovery and disposal. It creates no competing animation loop.
- State validation, rejection of asynchronous reducers and engine objects, and isolated subscriber failures.

This is a building block for discrete rules, puzzle boards, resources, story choices and progression. Sprites, meshes and high-frequency physics stay in the native engine. Generated games still have to wire appropriate actions, rendering and debug getters. Recovery cancels scheduled work; games re-arm ongoing rules timers explicitly when needed.

### Remove remaining creative constraints and integration hazards

- Zero-actor games and explicit absent win/lose conditions now validate.
- Genre/control labels no longer silently demote declared escalation; an escalating puzzle or pointer-driven simulation is valid.
- The always-on workflow no longer requires combat feedback, fixed genre-reference templates, or preservation of sample hazards/scoring/screens. Both prompt copies reflect the production architecture.
- Cleanup recognizes relative dependencies between engine modules, avoiding deletion of a live sibling import.
- The runtime remains modular; existing module-size checks were preserved rather than relaxed.

### Evidence and limits

New regression coverage exercises schema rejection, cross-genre scalar assertions, mandatory planning, design carry-forward, staged worker execution, frozen requirements, full-suite repair and publication, follow-up retention, transactional rules, deterministic recovery, timers and persistence. Chromium tests perform actual pointer/key interactions against the new session runtime, check independent scenarios, and demonstrate that a broken reset fails while the main action still passes.

Coverage proves the declared requirements, not that the model extracted every nuance of the brief or that the resulting game is enjoyable. A model can still design weak scenarios; source review, richer scenario design and representative live generation evaluations remain important. This change introduces no new game engine and does not relax browser isolation, CSP, tenant storage boundaries or network policies. Existing project sources are not bulk rewritten, and no production deployment is included.

Current validation: the full workspace test run passed 3,800 tests (one existing skip). The additional milestone-rollback regression and its five companion worker tests also passed, bringing the tested total to 3,801. Workspace type checking and lint passed; the worker type check also passed after adding the final regression. `git diff --check` is clean. No model-generation benchmark or deployment was run.

## First-pass fixes

| Finding in the code | Change | Player impact |
| --- | --- | --- |
| The first-draft prompt described Three.js APIs and fighting opponents for every engine and brief. | Separate Phaser, Three.js and existing Canvas2D contracts; shared mechanics-first requirements for both draft and interactive generation. Remove compulsory combat and win/lose assumptions. | Builders, puzzles, narratives, simulations and hybrids retain their own rules. |
| Random variation chose duel cameras, combat arenas, stamina, parries and environmental kills regardless of the idea. | Use genre-neutral composition and interaction treatments; preserve the declared perspective; make visual suggestions subordinate to the brief. | Variation changes presentation without substituting another game. |
| Genre playbooks overrode explicitly authored custom verification. | Prefer a declared custom contract; freeze the selected plan before verification and reject contract replacement during repairs. Persist the plan actually used. | Novel mechanics can be verified without pretending to support unrelated WASD actions. |
| Outcome checks required familiar field names such as score or health. | Allow an explicit outcome assertion on arbitrary state names. | Completion can mean connected terminals, harmony, harvest or other game-specific state. |
| Drafts discarded modules shorter than 80 characters and wrote incompatible exports. | Accept nonempty small modules, reject duplicate paths, and validate known module exports/runtime API calls against the proposed tree before writing. Retry once with specific diagnostics. | Small glue modules survive; detectable link failures are repaired before a partial draft lands. |
| Repair orchestration claimed to keep the best attempt but mostly shipped the last one; the edit fallback used a blanket rollback. | Rank observed attempts, preserve code/assets/spec/edit intent together, and restore an earlier stronger attempt on measurable deterioration. Recover from exhausted syntax repairs when a valid earlier attempt exists. Recheck restored bytes. | Cosmetic polishing cannot silently replace a working build with a demonstrably worse repair. Partial improvements are retained. |
| Seeded loops had no disposal or manual pause and advanced on the first frame after a tab stall. | Shared bounded frame loop, visibility pause, stable manual pause/resume, optional fixed-step simulation and lifecycle cleanup. | More consistent timing and safer restarts/tab switching. |
| Canvas resizing followed window events only; collapsed containers could produce invalid dimensions. | Observe actual container size, avoid redundant backing-store resets, bound dimensions and DPR; dispose observers and Three.js scene resources. | Resizing editor panels works without a window resize; high-DPR devices avoid excessive canvas resolution. |
| Every sound allocated nodes without cleanup, voice limits or mute, and audio errors could break gameplay. | Shared bounded audio graph, envelopes, voice cleanup, mute/dispose, gesture unlocking and guarded audio availability. | Audio failures do not stop play, and bursts/restarts have bounded audio resource use. |
| Phaser touch buttons released by coordinates, retained anonymous listeners after destruction, and visibility did not disable input. | Track pointer ownership, handle release outside, clear on focus loss/hide, and remove listeners on scene shutdown. | No stuck action after dragging off a button; restarts do not accumulate touch handlers. |

## Verification and limits

First-pass baseline validation: `pnpm test` passed across all 15 workspace tasks (3,758 tests passed, one existing test skipped); `pnpm typecheck` and `pnpm lint` passed. An earlier simultaneous test/typecheck run hit the existing agent-parity test's five-second timeout; the focused test and the final full suite passed without changing its timeout or assertions.

Regression tests cover each change, including custom pointer mechanics under a recognized genre, immutable repair contracts, runtime/syntax rollback after visual polish, binary asset restoration, 30/60/120 Hz simulation, pause/dispose, resizing, audio limits and multi-touch lifecycle. A real Chromium test runs the actual seeded Canvas2D engine to check rendering, container resizing, DPR limits and disposal. Existing browser-worker tests cover input delivery, runtime errors and network isolation.

The runtime changes apply to newly seeded projects. Existing games are not bulk-rewritten. The draft fast path is currently provider-specific; the shared interactive prompt and worker verification changes apply across providers. No origin, CSP or network-isolation policy was relaxed.

These checks establish concrete correctness improvements, not a measured guarantee of subjective game quality. No paid model generation benchmark or production deployment was performed. A representative live comparison across original user briefs is still needed to quantify improvements in fidelity, depth, visual quality, completion rate and generation cost.

