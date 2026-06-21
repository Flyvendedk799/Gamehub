# PlayerZero Engine Evolution v2 — a 10-Phase Plan (data-rooted)

> **North star (unchanged).** PlayerZero is "Lovable for games": every user
> brings a *new and different* idea, and the engine must build it *well* — not
> fit it into a box.
>
> **What changed.** v1 made capabilities **discoverable** — a genre-agnostic
> `capabilities` model, a push recommender, 16 skills, a decoy detector,
> capability-aware invariants, and per-run telemetry. v2 attacks the layer
> **underneath** v1: the data shows the discoverable scaffolding is in place but
> **not load-bearing**. Skills are *viewed but never run*. The verdict layer is
> *dead on arrival*. The recommender is *keyword-brittle*. Half the genres ship
> *unverified*. v2 makes capabilities **executable** and verification
> **universal**.

This plan is rooted in an **8-run batch** of deliberately diverse generations
through the v1 engine (+3 prior probes = 11 total), each captured by the v1
telemetry (`run_quality_metrics.report`) and cross-checked against the **actual
generated code** (`scripts/analyze-runs.ts` + a per-run source grep). It was
synthesized by a 6-lens analysis workflow and hardened by an adversarial critique
that verified every load-bearing claim against the source tree.

---

## 0. Evidence base

### The 8-run batch (2026-06-21, codex, instrumented)

| # | Idea | genre / engine | shipReason | tokens / calls | skills **viewed** | skills **used in code** | key signal |
|---|---|---|---|---|---|---|---|
| 1 | Garden (drag/ambient) | other / phaser | passed (via contract) | **853K / 101** | juice only | **0** | **engineEscaped=true** — wrote vanilla canvas + decoy shim; `escalates:true` mis-declared |
| 2 | Dungeon roguelike | roguelike / phaser | passed | 271K / 43 | enemy-ai, procedural-gen | **0** | cheapest; clean |
| 3 | Tower defense | tower_defense / phaser | **repair_exhausted** | **597K / 122** | economy-system, wave-spawner | **0** | hit repair ceiling on missing-field predicates |
| 4 | Detective visual novel | visual_novel / phaser | **no_verdict** | 360K / 71 | dialog-flow | **0** | no playbook + no contract → unverified; 26.5KB file |
| 5 | One-thumb faller | runner / phaser | **no_verdict** | 236K / 57 | mobile-controls, procedural-gen | **0** | runner playbook has **0 predicates** |
| 6 | Four-lane rhythm | rhythm / phaser | **no_verdict** | 244K / 54 | juice only | **0** | **rhythm-clock never recommended** (keyword miss); `escalates` false-pos |
| 7 | Precision platformer | platformer / phaser | passed | 294K / 67 | level-orchestrator, save-state | **0** | re-derived save via raw `localStorage`; `escalates` false-pos |
| 8 | 3D arena survival | tps / three | passed | 242K / 48 | enemy-ai, wave-spawner | **0** | clean; the three path works |

**Aggregate:** adoptionRate (opened a matching skill) **77.8%** · **usesSkillFns 0/8** · missedAdoptionRate 81.8% · contractCoverageRate **18.2%** · `debugSnapshot` wired **0/8** · no_verdict/repair_exhausted **4/8** · boxEscapeRate 9.1% · falseWarningRate (genre=other) 100% · tokenP50 360K / **P90 597K** · juiceP50 385 · bootedRate 100%.

### Six findings that drive the plan

1. **Skills are viewed, never run** — `usesSkillFns=0` in **8/8**. The only delivery path is `view_game_feel` returning the module *as text*; the prompt then says "adapt — do not paste verbatim." So the agent pays read-tokens **and** re-derivation-tokens **and** ships fresh bugs (run 7 re-derived `save-state` as raw `localStorage`; run 3 hand-wrote 35 escalation tokens and still failed). This is the single dominant signal.
2. **The verdict layer is dead on arrival** — the only shipped `debug.snapshot` is the **null stub** (`packages/runtime/src/engines/types.ts`). `snapshot()===null` ⇒ every predicate reports "field missing" ⇒ a real playbook can *never* pass (run 3 burned to the repair ceiling on exactly this) and genre-less games ship `no_verdict`.
3. **The recommender is keyword-brittle** — `recommendSkills` reads only `capabilities` (never `genre`) and matches mechanic *substrings*; run 6 declared `genre:'rhythm'` but its mechanics dodged the `['rhythm','beat','music','timing']` list, so `rhythm-clock` was never recommended.
4. **Capability self-declaration is noisy** — `escalates` was mis-set `true` on the garden, rhythm, and platformer (none should ramp), driving false escalation warnings and irrelevant `wave-spawner` pushes. Declarations are trusted raw with zero reconciliation.
5. **Verification has structural holes** — 6 of 18 genres have no playbook; the runner playbook ships **zero predicates**; the genre vocabularies have **drifted into three copies** (shared 18-enum, the invariant module's legacy 10-enum, and a third in the prompt), so the genre-side escalation gate is effectively dead.
6. **The engine box still leaks at the edges** — ambient/drag ideas don't fit phaser/three, so the only way to ship them is to lie (run 1's decoy). And whole idea-categories (real audio for rhythm, 3D model depth, multiplayer) have no substrate at all.

**Thesis:** v1 gave the agent a *menu*; v2 makes the menu items *real* — importable code that runs, a snapshot the verdict layer can read, recommendations that fire on intent, declarations that are checked, verification for every genre, and honest runtimes for the ideas that don't fit a scene framework.

---

## Sequencing

```
Foundation     1  Importable skill modules (skills that RUN)
               2  Auto-scaffolded debug.snapshot (verdict layer comes alive)
Targeting      3  Semantic + genre-driven recommendation
               4  Capability reconciliation (clean the declared flags)   ─┐ feeds
               5  Context-aware escalation + one genre vocabulary         ─┘ 4→5
Verification   6  Backfill playbooks + mandatory contract for the rest
               7  Convergent repair (root-cause classification)
Reach          8  First-class canvas2d engine (close box-escape at source)
               9  Asset substrates (music/beatmap + glTF)
              10  Honest multiplayer intent (local-scope + same-origin relay)
```

Each phase: **Problem (evidence) → Concrete changes → Verify → Effort/leverage.** Phases 1, 2, 3, 6, 8 are ship-as-is (highest leverage, cleanly grounded); 5 and 7 are scoped tight per the critique; 4 feeds 5; 9/10 are the correctly-sequenced lower-leverage tail.

> Citations point at real files. Skills live in `packages/core/src/game-skills/{phaser,three}/`. Note the `debug.snapshot` wiring shown in skill files is **commented usage examples**, not live exports — which is exactly why Phase 2 is needed.

---

## Phase 1 — Importable skill modules (make skills RUN, not get retyped)

**Problem (evidence).** `usesSkillFns=0` in **8/8** — the dominant corpus signal. The 16 skills are real ES modules with named exports (`createSaveState`, `createWaveSystem`, `makeEnemyBrain`…), but the only delivery is `view_game_feel` returning the source as text, and the prompt instructs "adapt — do not paste verbatim." Run 7 opened `save-state` then shipped 3 hand-rolled `localStorage` calls; run 3 viewed `wave-spawner` then hand-wrote 35 escalation tokens and still `repair_exhausted` at 597K/122. The 98.5KB of skill source is paid as read-tokens then thrown away.

**Goal.** A skill the agent recommends is **written into the project and imported**, so the vetted, tested code actually runs.

**Concrete changes.**
- New tool `packages/core/src/tools/import-skill.ts`: `import_skill({ name })` writes the vetted module to a canonical path (`src/engine/<skill>.js`) via the same `TextEditorFsCallbacks` the editor uses; returns the import line + the public API signature; registers the path so `validate_game_scene`/`assert_game_invariants` see it.
- In `choose-engine.ts` execute, **auto-stage** the recommended skill modules into `src/engine/` so they exist before the agent writes a line (it does `import { createSaveState }` instead of retyping).
- `assert_game_invariants`: a `usesSkillFns` check — a skill staged-but-never-called emits a soft warn, closing the 81.8% missed-adoption loop with a hard, build-report-surfaced signal.
- Rewrite the prompt's "adapt / do not paste verbatim" lines to "`import_skill` then call its exports"; keep "adapt" **only** for the small inline feel snippets (screen-shake etc.).
- Extend `game-feel-library.ts` to mark *capability* skills (importable) vs *feel* snippets (inline) via a new `// exports:` header line.

**Verify.** New `eval-games` fixtures per capability genre asserting `usesSkillFns>0` after `import_skill`; re-run the 8-run corpus and assert `skillImportRate>0` for qualifying runs and **tokenP90 597K→<400K** as re-derivation drops. Suite + `eval:games` stay green.

**Effort L · leverage high · ship as-is.**

---

## Phase 2 — Auto-scaffold a real `debug.snapshot()` (bring the verdict layer alive)

**Problem (evidence).** The whole verdict layer reads `window.__game.debug.snapshot()`, but the only scaffold shipped is the **null stub** in `packages/runtime/src/engines/types.ts`. `debugSnapshot=0` in **8/8**. With `snapshot()===null`, `resolvePath` (`playtest-score.ts`) returns undefined → every predicate fails "field missing." Run 3's real 4-predicate tower-defense playbook could *never* pass and burned to `MAX_REPAIR_ROUNDS_CEILING`; run 8 "passed" only via the boot path, not a play verdict.

**Goal.** Every game exposes a real snapshot by default, so predicates and contracts have something to read.

**Concrete changes.**
- In `gameGlobalSetupSnippet` (`types.ts`) replace the null stub with a **capability-aware default getter**: Phaser → first physics sprite x/y as `playerPos` + `window.__game.state.score/lives/wave`; Three → first non-camera `Object3D` position.
- Add a one-line opt-in `window.__game.debug.track({ player, score: () => … })` so the agent binds real entities instead of re-deriving a serializer.
- Phase-1 imported skills auto-register their `getState()` into the snapshot on init (wire it in `import-skill.ts` staging).
- `validate_game_scene` emits a **hard error** when a spec with completable/playbook capabilities ships `snapshot()===null` and never calls `track` — analogous to the existing `controls.define` check.

**Verify.** Re-run the tower-defense fixture: with a populated snapshot its 4 predicates become satisfiable and it reaches a real pass/fail instead of `repair_exhausted`-on-missing-field. Runtime unit test: the default getter is non-null for a one-sprite Phaser scene and a one-mesh Three scene. Assert `debugSnapshot>0` in the re-run corpus.

**Effort M · leverage high · ship as-is.**

---

## Phase 3 — Semantic + genre-driven recommendation

**Problem (evidence).** `recommendSkills` (`recommend-skills.ts`) takes only `capabilities`, never `spec.genre`, and matches mechanic *substrings* against tiny arrays. Run 6 declared `genre:'rhythm'` but `mechanics:['hit timed notes','judge accuracy','build combo']` — zero overlap with `['rhythm','beat','music','timing']` — so `rhythm-clock` was neither recommended nor used; the run hand-rolled timing and shipped `no_verdict`.

**Goal.** A correctly-classified game gets the right skill regardless of phrasing.

**Concrete changes.**
- Pass `spec.genre` into `recommendSkills(spec)` and add a **genre→skill table** (rhythm→rhythm-clock; tower_defense→economy-system+wave-spawner+enemy-ai; visual_novel→dialog-flow; roguelike→procedural-gen; runner+touch→mobile-controls).
- Replace literal substring arrays with a **synonym/stem map** (rhythm: rhythm|beat|music|timing|tempo|note|combo|judge|lane|sync; animation: animate|cutscene|sequence|choreograph), unioned with the genre table.
- Longer-term: capability→skill via a **precomputed embedding-similarity** lookup over each skill's `// when_to_use` header, so new skills don't require editing `recommend-skills.ts` (precompute at build time to keep the function pure).
- Wire `choose-engine.ts` to pass the spec through.

**Verify.** Unit test: `recommendSkills` on run 6's exact spec returns `rhythm-clock`; fixtures for paraphrased rhythm/animation/narrative mechanics. Re-run corpus: `recommendedButUnused` no longer omits the genre-canonical skill for rhythm/VN/TD.

**Effort M · leverage high · ship as-is.**

---

## Phase 4 — Capability reconciliation (clean the declared flags before they're trusted)

**Problem (evidence).** `GameSpec.capabilities` is taken verbatim with **zero validation**. `escalates` is a free boolean that drives *both* the escalation invariant and the `wave-spawner` recommendation, so one noisy flag becomes both a false warning and an irrelevant push. `escalates` was mis-declared `true` in ≥3/8 (garden, rhythm, platformer), all of which tripped escalation false-positives and got spurious `wave-spawner` recommendations.

**Goal.** Self-declared flags are cross-checked and demoted before consumption. *(This phase owns **pre-build flag hygiene**; Phase 5 owns the invariant's mode logic — they share the goal of killing the escalates false-positives, split cleanly so the data shows which fix worked.)*

**Concrete changes.**
- New pure `validateCapabilities(spec)` (in `@playforge/shared/game-spec.ts`), run in `declare-game-spec.ts` **before** `setSpec` and again at `done.ts`: a **demote-don't-trust** rule table — `escalates && genre∈{platformer,puzzle,visual_novel,sandbox,rhythm}` → suspect; `escalates && controlScheme∈{drag,pointer} && !hasEnemies` → drop to false (the garden); `!hasEnemies` but combat-driven fail state → flag.
- Return conflicts in the tool result so the model must amend or justify before `choose_engine`.
- Add `capabilitiesCorrected[]` to the build-report jsonb so we can trend declaration accuracy.
- Post-build reconciliation in `done.ts`: compare *declared* `escalates` against whether `ESCALATION_PATTERNS` actually matched; if declared-but-absent, say "implement it or drop the flag" instead of the blind warning.

**Verify.** Unit test `validateCapabilities` demotes/flags `escalates` on the garden/rhythm/platformer specs. Re-run corpus: escalation false-positives 3/8 → ~0; `wave-spawner` stops appearing in `recommendedButUnused` for non-escalating games.

**Effort M · leverage high · feeds Phase 5.**

---

## Phase 5 — Context-aware escalation + one genre vocabulary

**Problem (evidence).** `assert-game-invariants` gates escalation on a flat boolean, then checks `ESCALATION_PATTERNS` that **only** match wave/spawn signals. A platformer that legitimately escalates via *handcrafted level difficulty* has none of those → false "no escalation detected" (run 7). Worse, the module keeps a **legacy 10-value genre enum** separate from the canonical 18-value shared enum, and `SHOULD_ESCALATE_GENRES` is keyed on tokens the spec can no longer emit (`shooter`/`survival`) — so the genre-side gate is **dead**, and a third genre vocabulary lives in the prompt.

**Goal.** Escalation reasons by *mode*, and there is exactly one genre vocabulary. *(Per the critique, this phase owns the mode logic + enum unification only; it does **not** re-drop the garden flag — Phase 4 already did, avoiding double-suppression.)*

**Concrete changes.**
- Derive an escalation **mode** from capabilities: `WAVE` (hasEnemies && escalates) → existing `ESCALATION_PATTERNS`; `LEVEL_RAMP` (hasProgression && escalates) → new `LEVEL_RAMP_PATTERNS` (`nextLevel`/`loadLevel`/`levelIndex++`/use of `level-orchestrator`).
- Retire the legacy `GameGenre` enum in the invariant module; make `@playforge/shared` `GameGenre` the single source of truth; re-key `SHOULD_ESCALATE_GENRES` to spec tokens (`shmup`, `runner`, `tower_defense`, `topdown_arcade`, `tps`-when-`hasEnemies`).
- Replace `mapSpecGenreToInvariantGenre`'s single special-case with a `genre→{invariant set}` table on spec tokens (fighting→combo/hitstop/limb; rhythm→timing-accuracy/judgment-window).
- Delete the third "brawler" vocabulary from `game-workflow.v1.txt`; speak only spec tokens.

**Verify.** Unit test: platformer spec → `LEVEL_RAMP` mode, no warning when `loadLevel`/`level-orchestrator` present; 3D-arena → `WAVE` mode, passes. Re-run corpus: escalation false-positives → ~0. Depends on Phase 4's clean flags.

**Effort M · leverage high · scoped per critique.**

---

## Phase 6 — Backfill playbooks + mandatory contract for the rest

**Problem (evidence).** `hasPredicates` gates on `plan.predicates.length>0`; otherwise the run ships `no_verdict`. Two holes: (a) 6 of 18 genres have **no playbook** (`visual_novel`, `rhythm`, `sandbox`, `tycoon`, `idle`, `other`); (b) the **runner playbook ships zero predicate blocks**. The advertised escape hatch `declare_playtest_contract` almost never fires (coverage 18.2%). The 3 `no_verdict` runs are exactly the no-/empty-playbook genres (VN, rhythm, faller); the genres *with* predicate-bearing playbooks all reached real verdicts.

**Goal.** Every game gets a real deterministic verdict — a playbook where one fits, a mandatory contract where one doesn't.

**Concrete changes.**
- Backfill machine-checkable predicates onto the empty-playbook genres (`PlaytestPredicate` shape): runner → run-axis increased + `playerPos.y` changed on jump; fps → yaw-delta; puzzle → score/grid change.
- Add `visual_novel` (advance → `dialogueIndex` increased; choice → route changed), `rhythm` (on-beat key → score/combo up; deliberate miss → combo resets), `sandbox`/`tycoon` (place/build → entity count + resource delta), `idle` (tick → currency accrues) playbooks; register them in `PLAYBOOKS` + `getPlaytestPlaybook`.
- For inherently un-playbookable genres (`other`, VN branches): make `declare_playtest_contract` **mandatory** in `run-generation.ts` — no predicate-bearing playbook **and** null contract at `done` ⇒ refuse `done` with a "declare a contract" error instead of shipping `no_verdict` (mirror the completability floor).

**Verify.** Unit test `getPlaytestPlaybook` returns predicates for `visual_novel`/`rhythm`/`runner`. `eval-games` fixtures for VN + rhythm + faller reach a real pass/fail. Re-run corpus: `no_verdict` 4/8 → 1–2/8. Depends on Phase 2 (predicates need a readable snapshot).

**Effort L · leverage high · ship as-is.**

---

## Phase 7 — Convergent repair (classify the root cause)

**Problem (evidence).** `buildRepairInstruction` (`repair-loop.ts`) turns **every** failing predicate into the *same* sign-error message ("the input is mis-wired or sign-flipped — trace the keydown handler"). But when `snapshot()===null` (the actual 8/8 state), the failure reason is "field missing" — a *different* root cause. The agent then edits input handlers that were fine, the field is still missing next round, and it burns to the ceiling: run 3 `repair_exhausted` at 597K/122 (the single run that sets tokenP90).

**Goal.** Repair instructions match the actual failure, so the loop converges. *(Per the critique: keep only the genuinely-new root-cause classification — the token budget already exists; reframe as tightening it, and add the new telemetry tag.)*

**Concrete changes.**
- Branch `buildRepairInstruction` on `PredicateResult.reason` (the distinct strings already exist in `playtest-score.ts`): majority "is missing" → a **snapshot-contract** instruction ("your game exposes no `debug.snapshot` for fields A,B,C — wire `debug.track`; do NOT touch input handlers"); reserve the sign-error text for present-but-wrong values.
- Use the existing `PlaytesterOutput.hasDebugContract` for a pre-round short-circuit to the snapshot-contract instruction before scoring.
- On round ≥2 with the same field failing, escalate to naming the recommended skill ("stop hand-rolling targeting — `import_skill enemy-ai`"), using the `recommendSkills` output already computed at `choose_engine`.
- Reframe cost control as **tightening the existing validation-tail budget for snapshot-missing runs** (not a new budget); tag telemetry with a new `repairKind` (`snapshot_contract` vs `sign_error`).

**Verify.** Unit test: all-missing verdict → snapshot-contract text (no "keydown handler" phrasing); present-but-wrong → sign-error text. Re-run the TD fixture: converges in round 1 to wire-snapshot (after Phase 2) instead of exhausting; `repair_exhausted` tool calls 122 → <70. Depends on Phase 2.

**Effort M · leverage high · scoped per critique.**

---

## Phase 8 — First-class `canvas2d` engine (close box-escape at the source)

**Problem (evidence).** `choose_engine` is a hard `three|phaser` union (and so are `GameEngineId`, the adapters map, and the `engine_kind` pg-enum). Yet the system *tells* the agent raw canvas is allowed while giving no bootstrap, validator, engine id, or guide — so the only way to ship canvas is to **lie**: declare phaser, write vanilla canvas + a dead Phaser shim. Run 1 (garden, drag/ambient) did exactly that — `engineEscaped=true`, the **most expensive run** (853K/101). `checkEngineFit` has no rule for the ambient case, so it force-fits phaser without even a warning. *(This is the v1-deferred phase, now validated as necessary by real data.)*

**Goal.** An honest custom-2D runtime, with capability-driven routing and built-in verification, so ambient/abstract/drag ideas never need to escape.

**Concrete changes.**
- New `packages/runtime/src/engines/canvas2d.ts` implementing `GameEngineAdapter`: `bootstrap()` emits `<canvas>` + the engine-agnostic `gameGlobalSetupSnippet` (controls/reportScore/debug already there), **no CDN import-map** (boots faster than Phaser's ESM fetch, itself a flake source); `validate()` requires `requestAnimationFrame` + `getContext('2d')`, forbids `eval`/`new Function`, runs `detectNetworkReferences`.
- Register `canvas2d` in the adapters map, extend `GameEngineId`, additive `engine_kind` enum migration (psql per CLAUDE.md), extend the exporter/`game-html` gates.
- `checkEngineFit` gains a `canvas2d` branch driven by **capabilities, not genre**: reject 3d; **warn** (never reject) when phaser/three is picked for `dimensions:2d && controlScheme∈{drag,pointer} && !hasPhysics && !hasEnemies` (the ambient fingerprint), suggesting `canvas2d`. Add a pure `recommendEngine(capabilities)` returning a *soft* preference surfaced alongside skill recs.
- Bake verification in: ship a **populated** snapshot stub `{progress,score,t,pointer}`; a new `canvas2d-engine-guide.v1.txt` makes `declare_playtest_contract` a required step (no genre playbook); add WebAudio + canvas-flash signals to `FEEDBACK_PATTERNS` so canvas feedback isn't false-flagged.

**Verify.** `eval-games` fixture for the garden/tide idea pinned to `canvas2d`: assert `engineEscaped=false` (decoy detector silent) + a passed contract verdict. Unit test `canvas2d.validate()` rejects `eval`/missing rAF. Re-run garden: `engineEscaped` 1→0 by construction; tokens drop from 853K. Depends on Phases 2 + 6.

**Effort L · leverage high · ship as-is (the v1 deferral, now data-justified).**

---

## Phase 9 — Asset substrates (music/beatmap + glTF)

**Problem (evidence).** Two whole idea-categories can't be done *great* for lack of assets. (a) **Audio**: the bank ships only two synthesized music entries — no real song, BPM, or beatmap — and `rhythm-clock` runs off `scene.time` against a track that doesn't exist, so a perfectly-clocked rhythm game is silent or fakes it (run 6). (b) **3D**: the `three/` skills have **no model loader** (no `GLTFLoader`/`InstancedMesh`), so every 3D idea is primitives — run 8 *passed cheaply* (242K/48), proving the logic path works, but the visual ceiling caps the whole 3D category.

**Goal.** Real audio-sync and 3D-model substrates, importable and recommended.

**Concrete changes.**
- Add CC0 looping tracks with `bpm`/`offset`/`beatmap` metadata to the audio-bank manifest + a `music-sync` skill (phaser+three) that decodes via `AudioContext.decodeAudioData`, exposes `audioTime`, and drives `rhythm-clock` from real playback.
- Add a `three/asset-pipeline` skill loading **same-origin** (CSP-legal) glTF/glb + a bundled CC0 low-poly primitive kit + an `InstancedMesh` helper.
- Add a `2_5d` depth playbook (layered-parallax / billboard-sprite) so the already-enumerated dimension becomes verifiable.
- Both new skills importable via Phase 1 and recommended via Phase 3 (rhythm→music-sync; tps/3d→asset-pipeline).

**Verify.** `eval-games` fixture: a rhythm game importing `music-sync` reaches a passed verdict with real `audioTime`-driven scoring (depends on Phases 2+6). A 3D fixture importing `asset-pipeline` loads a same-origin glb without tripping `detectNetworkReferences`. Manifest schema test asserts `bpm`/`beatmap` fields.

**Effort L · leverage medium.**

---

## Phase 10 — Honest multiplayer intent

**Problem (evidence).** "Any user idea" includes co-op/versus/.io — a whole category the engine can't serve **and silently drops**. The sandbox pins CSP `connect-src 'self'` and warns on any non-self socket; there is zero multiplayer surface, and `GameCapabilities` has no networking trait, so "online co-op survival" quietly becomes single-player. The corpus contains no multiplayer attempt because nothing would let one through — run 8 (the closest) shipped strictly single-player.

**Goal.** Declare the capability, scope honestly to what's CSP-legal, and (later) stand up a same-origin relay.

**Concrete changes.**
- **Phase A (cheap, honest):** add a `requiresNetworking` capability + a classifier in `validateCapabilities` (Phase 4); a multiplayer-implying idea must either scope to a same-origin **local** build (split-screen / hotseat — fully CSP-legal, a real great subset) **and say so**, or explicitly decline the online part — surfaced in the build-report. `done.ts` refuses to ship a multiplayer-implying spec without one of those.
- **Phase B (infra, deferred):** a platform-owned **same-origin** realtime relay (a `/rt` endpoint under the project's own origin, so `connect-src 'self'` holds) + a `netplay` skill (importable via Phase 1) exposing rooms + authoritative-tick sync — unlocks turn-based and lightweight .io without breaking origin isolation.

**Verify.** Phase A: unit test the classifier flags "online co-op" and that `done` refuses to ship without a local-scope ack or explicit decline; `eval-games` fixture for a co-op idea ships as honest local-multiplayer. Phase B is a separate infra milestone.

**Effort L · leverage low · correctly sequenced last.**

---

## Metrics (all from the existing telemetry)

Track per release from `run_quality_metrics.report`, against the batch baseline:
- **Skill execution:** `usesSkillFns>0` rate **0% → >80%** for capability-qualifying runs (Phase 1's headline).
- **Verification:** `debugSnapshot` wired **0% → ~100%**; `no_verdict`+`repair_exhausted` **4/8 → ≤1/8**; contractCoverage where required **→ 100%**.
- **Targeting/accuracy:** escalation false-positives **3/8 → ~0**; genre-canonical skill never missing from recommendations.
- **Cost:** tokenP90 **597K → <400K** (Phase 1) → **<300K** (Phase 7); `repair_exhausted` tool calls **122 → <70**.
- **Reach:** boxEscapeRate **9.1% → 0**; rhythm/3D categories reach passed verdicts with real audio/models.

## Adversarial-critique verdict

Synthesized by a 6-lens workflow and verified against the tree: **9/10 phases cite real, confirmed signals and name actual files/mechanisms.** The plan attacks the layer *below* v1 (capabilities/push-recommend/decoy-detector are treated as the substrate to fix, not re-proposed). Applied fixes: Phase 7 trimmed to the novel root-cause-classification half (the token budget already exists — reframed as tightening it, plus the new `repairKind` tag); Phases 4/5 split cleanly (4 = pre-build flag hygiene, 5 = mode logic + enum unification, no double-suppression); citations corrected (`game-skills/{phaser,three}/`; the skill snapshot wiring is commented examples, which strengthens Phase 2). **Recommended order:** ship 1, 2, 3, 6, 8 first (highest leverage); 4→5 and 7 next; 9/10 as the tail.
