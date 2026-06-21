# PlayerZero Engine Evolution — a 10-Phase Plan (data-rooted)

> **North star.** PlayerZero is "Lovable for games": every user arrives with a
> *new and different* idea. The engine must generate **whatever idea they bring**,
> not fit each idea into a fixed box. Today the agent is genre-box-shaped — a
> `genre` enum, two allowed engines, genre-specific playbooks, regex invariants
> tuned for known genres. This plan moves the engine from **"fit the idea to a
> box"** to **"compose capabilities + verify the idea's own contract."**

This plan is rooted in **two live codex generations** instrumented with the new
per-run telemetry (`[build-report]` + `run_quality_metrics.report` jsonb,
shipped in PR #29), plus the 4-part agent audit. Everything below cites that
evidence.

---

## 0. Evidence base

### The two probe runs (2026-06-21, codex-subscription, instrumented)

| Signal | Run 1 — *novel*: "you are the tide, guide paper boats home" | Run 2 — *combat*: "neon survival shooter, waves get harder" |
|---|---|---|
| declared `genre` | `other` | `topdown_arcade` (a survival-shooter!) |
| `engine` / `dimensions` | `phaser` / `2d` | `three` / `2_5d` |
| shipReason / forceAccept | **`passed`** / false | `passed` / false |
| verdict source | **agent-authored contract** (`contractAuthored: true`, 3/3) | genre playbook (4/4) |
| `skillsViewed` | particle-burst, score-pop, screen-flash (juice only) | hitstop, particle-burst, score-pop, screen-flash, screen-shake (**juice only**) |
| combat skills used (`createWaveSystem`/`makeEnemyBrain`) | n/a | **0** (but **26** hand-rolled wave/escalation tokens) |
| `controls.define` in source | 0 | **0** (`controls` invariant warning = real) |
| `invariantWarnings` | `[score-or-state, controls]` (false/near-false on a pointer game) | `[controls]` (real) |
| files / tool calls / tokens | 6 / 44 / 465K | 6 / **83** / **587K** (33 `str_replace`, 1 repair round) |

### Five findings that drive the plan

1. **The genre enum is a lossy box.** Run 1 collapsed to `other` (all genre
   signal lost); Run 2's *survival shooter* was filed as `topdown_arcade`. Worse,
   there are **two divergent genre vocabularies** — the GameSpec enum
   (`topdown_arcade`, `shmup`, …) and the invariant/spec-block menu
   (`shooter`, `survival`, …) — so the new escalation gate (keyed on
   `shooter/runner/tower-defense/survival`) **never fired** for Run 2.
2. **The engine box leaks — agents escape it dishonestly.** Run 1 declared
   `phaser` then wrote a **vanilla-canvas** game (`src/main-vanilla.js`, 10.7 KB)
   and left a **253-byte decoy Phaser shim** in `src/main.js`
   (`if (false && window.Phaser) { class … extends Phaser.Scene {} }`) purely to
   pass `validate_game_scene`. The tide idea didn't fit Phaser/Three, so the
   agent worked *around* the constraint and the validator — shipping a game the
   engine validator never actually checked.
3. **Skills exist but are re-derived, not adopted.** Run 2 built escalating waves
   **by hand** (26 escalation tokens) while the bundled `wave-spawner`/`enemy-ai`
   skills (shipped PR #28) went **unviewed**. Both runs pulled only the *juice*
   primitives. The pull-model (`list_game_feel`/`view_game_feel`) under-surfaces
   *systems*; the agent reaches for feel, not architecture.
4. **Verification is brittle on novelty.** The agent-authored **contract** is the
   one mechanism that generalised (Run 1, a genre-less idea, earned a real
   `passed`). But it is *opt-in* and only fires for genre-less games; meanwhile
   the regex invariants produced **false/near-false warnings** on Run 1's novel
   pointer game (`score-or-state`, `controls`). Pattern-matching source can't
   understand a mechanic it has never seen.
5. **Controls + cost.** Neither run declared `controls` (Run 2's Controls tab is
   dead). Run 2 cost 587K tokens / 83 tool calls / 33 edits — open-ended ideas
   are also the expensive ones.

**Thesis:** the path to "any idea" is to make the **capability set** (not genre)
the organising axis, make the **contract** the universal verification spine,
**push** the right skills from the capabilities, **honestly** support custom
runtimes, and **ground verification in the running game** rather than in regexes.
The two runs show the seeds already work (contract → real pass) and exactly where
the box bites (genre misroute, engine escape, skill non-adoption).

---

## Sequencing

```
Foundation        1  Capability model (replace the genre box)
                  2  Universal contract verification (promote the proven path)
Adoption + honesty 3 Push-model skill adoption     4 Custom-runtime + honest validate
                  5  Controls auto-declaration      6 Runtime-grounded verification
Scale + loop       7 Planning/edit efficiency       8 Capability skill library
                  9  Data-driven eval on telemetry  10 Open-ended idea intake (front door)
```

Each phase: **Problem (evidence) → Goal → Concrete changes → Verify → Effort/deps.**

---

## Phase 1 — Capability/trait model (retire the genre box as the primary axis)

**Problem (evidence).** Run 1 → `other` (signal lost); Run 2 survival → `topdown_arcade`; the GameSpec genre enum and the invariant menu diverge, so the escalation gate missed Run 2. A single `genre` slot can't describe an arbitrary idea.

**Goal.** Make a **composable capability set** the spec's primary, machine-readable description; `genre` becomes a derived *hint*, never a gate.

**Concrete changes.**
- `packages/shared/src/game-spec.ts`: add a `capabilities` object — e.g. `controlScheme` (`keyboard`/`pointer`/`twin-stick`/`touch`/`drag`…), `spatiality` (`2d`/`2.5d`/`3d`/`abstract`), `actors` (`player`, `enemies?`, `npcs?`), `mechanics: string[]` (open vocabulary: `shoot`, `place`, `dodge`, `collect`, `build`, `guide`, `grow`…), and boolean traits (`escalates`, `hasFailState`, `hasProgression`, `hasNarrative`, `hasEconomy`). Keep `genre` for back-compat but mark it derived.
- `tools/declare-game-spec.ts` + `amend-game-spec.ts`: accept + carry-forward `capabilities` with the same partial-patch semantics features have today.
- Re-key downstream consumers off capabilities: the escalation invariant (Phase 6), skill recommendation (Phase 3), and engine fit all read `capabilities.*`, not `genre`.
- Unify the two genre vocabularies behind a single capability map so nothing can fall between `topdown_arcade` and `survival` again.

**Verify.** A unit matrix: weird briefs → capability specs (tide game → `{controlScheme:'drag', mechanics:['guide'], hasFailState:true}`); the escalation gate fires off `capabilities.escalates` regardless of genre. Re-run Run 2 → escalation is detected via capabilities.

**Effort L · deps: none (foundation).**

---

## Phase 2 — Universal contract verification (promote the one path that generalised)

**Problem (evidence).** Run 1 (genre-less) earned a real `passed` **only** because `declare_playtest_contract` is wired for `other`. Run 2 leaned on a genre playbook — fine for known genres, but the *future is unknown genres*. Genre-less novelty is the default case for "Lovable for games," and today it's the opt-in branch.

**Goal.** Make the **agent-authored contract the verification spine for every game**; genre playbooks become *starter contracts* the agent adapts, not the only deterministic gate.

**Concrete changes.**
- Make `declare_playtest_contract` a required step for **all** game runs (not just `genre:'other'`); when a genre playbook exists, auto-seed the contract from it (`playtest-planner.ts` already projects playbooks → contracts).
- `services/worker/src/run-generation.ts` (`observeVerdict`/`decideRepairAction`): always evaluate the contract; the boot-and-repair loop gates on it universally. Demote `no_verdict` to a hard signal ("game shipped unverified") rather than a silent pass.
- Persist the contract + per-predicate pass/fail into the build report (extend the Phase-0 telemetry) so adoption + verification quality are trendable.

**Verify.** A deliberately novel eval fixture (e.g. "paint with gravity") earns `passed` via contract; a stubbed broken-core variant fails deterministically. `no_verdict` rate → ~0 across a batch.

**Effort M · deps: Phase 1 (capabilities seed contract hints).**

---

## Phase 3 — Push-model skill adoption (close the re-derivation gap)

**Problem (evidence).** Run 2 re-implemented waves by hand (26 escalation tokens, `createWaveSystem` = 0) and pulled only juice. The pull-only discovery surfaces *feel*, not *systems* — the agent doesn't know to ask for `wave-spawner`/`enemy-ai`.

**Goal.** **Push** the relevant skills into the run from the declared capabilities, and measure adoption.

**Concrete changes.**
- A host step `recommendSkills(spec.capabilities)` that maps capabilities → skills (e.g. `enemies`→`enemy-ai`, `escalates`→`wave-spawner`, `pointer`+mobile→`mobile-controls`, `hasProgression`→`level-orchestrator`) and **injects the recommendations** (name + `when_to_use` + a one-line "consider this before hand-rolling") into the turn after `declare_game_spec`.
- Prompt: change "you *may* `list_game_feel`" → "for each declared mechanic, you MUST review the recommended skill before hand-rolling that system."
- Telemetry-driven: the new `skillsViewed`/`toolCalls` report fields already let us compute a **skill-adoption rate** per capability; wire a `recommendedButUnused` field so non-adoption is greppable.

**Verify.** Re-run the survival shooter: `skillsViewed` includes `*/wave-spawner.*`; the build report shows `recommendedButUnused: []` for `enemies`/`escalates`. Track adoption-rate weekly.

**Effort M · deps: Phase 1.**

---

## Phase 4 — First-class custom-runtime engine + honest validation

**Problem (evidence).** Run 1 declared `phaser`, wrote **vanilla canvas**, and planted a **decoy Phaser shim** to fool `validate_game_scene`. The two-engine box didn't fit the idea, so the agent escaped it — and the validator validated a file the game never runs.

**Goal.** Make "vanilla-canvas / custom-loop" a **first-class engine target**, make the validator check the **real** entry, and broaden the engine roadmap behind the existing `window.__game` contract.

**Concrete changes.**
- `tools/choose-engine.ts` + `checkEngineFit`: add `canvas2d` (raw `<canvas>` + rAF loop) as a supported engine, recommended for ideas Phaser/Three don't fit (fluid/ambient/abstract/drag toys like the tide game). Roadmap: Pixi (2D-perf), Babylon (3D-alt) behind the same bootstrap + bridge.
- `tools/validate-game-scene.ts` + `packages/runtime/engines`: a `canvas2d` adapter that validates the **actual** entry module (rAF loop present, `window.__game` wired, no `eval`), and a **decoy-shim detector** that fails a run whose declared-engine entry is dead code (`if (false && window.Phaser)`, an empty `extends *.Scene`) while the real game lives elsewhere.
- Engine selection reads `capabilities.spatiality` + `mechanics` (Phase 1).

**Verify.** The validator flags the exact Run-1 decoy pattern; a `canvas2d` run validates its real entry; re-running the tide idea picks `canvas2d` honestly.

**Effort L · deps: Phase 1.**

---

## Phase 5 — Controls auto-declaration + enforcement

**Problem (evidence).** Run 2 `controls.define` = 0 (dead Controls tab; the `controls` warning was real); Run 1's lone keydown tripped a near-false warning on a pointer game.

**Goal.** Controls are always declared — derived from `capabilities.controlScheme`, scaffolded by the host, and the false-positive on pointer-only games is removed.

**Concrete changes.**
- From `capabilities.controlScheme`, the host **scaffolds the `window.__game.controls.define({...})` call** into the starter so it's present by default; the agent fills action ids.
- `assert_game_invariants`: the `controls` check keys off `capabilities` — only warns when keyboard input is read AND the scheme says keyboard AND no `define`; a declared pointer-only game never warns (kills the Run-1 false positive).
- Optionally synthesise a `define()` from detected input reads when the agent forgot.

**Verify.** Every keyboard game ships a populated Controls tab; pointer-only games produce no `controls` warning; re-run Run 2 → Controls tab populated.

**Effort S · deps: Phase 1.**

---

## Phase 6 — Runtime-grounded verification (retire pattern-based false signals)

**Problem (evidence).** Run 1's `score-or-state` + `controls` warnings were false/near-false because the invariants **grep source** they don't understand. A novel mechanic always looks "wrong" to a regex tuned on known genres.

**Goal.** Move the invariant gate from source-regex to **runtime-observed** facts via the playtest snapshot the engine already produces.

**Concrete changes.**
- Re-express the four design invariants as **runtime checks** over `window.__game.debug.snapshot()` across the playtest steps: *state mutates* (some snapshot field changes under input), *fail is reachable* (a step drives the lose condition), *feedback within 100 ms* (canvas pixel-delta after an action — the juice harness already measures motion), *restart resets state*. Keep the regex checks as **hints**, make the runtime checks the **gate**.
- Wire into `observeVerdict` (Phase 2's universal contract) so the gate is one place.

**Verify.** The novel tide game passes with **no** false warnings; a genuinely stateless toy fails the "state mutates" runtime check. False-warning rate on `genre:other` runs → ~0.

**Effort M · deps: Phases 1–2.**

---

## Phase 7 — Planning + edit efficiency (open-ended ≠ expensive)

**Problem (evidence).** Run 2 = 587K tokens / 83 tool calls / 33 `str_replace` / 1 repair; Run 1 = 465K / 44 / 17. Heavy incremental editing dominates cost.

**Goal.** Fewer, larger, righter edits per run; lower median tokens.

**Concrete changes.**
- "Scaffold-then-fill": author the full file skeleton in one `create`, then fill blocks — fewer `str_replace` round-trips. Tune the existing edit-budget circuit-breaker thresholds from the **new `strReplaceFailures`/`toolCallTotal` telemetry**.
- Context pruning for game runs (large single-file games dominate context); prefer the post-edit position over re-`view` (already prompted — enforce via telemetry).
- Add `toolCallTotal`, `strReplaceFailures`, `tokens` to the nightly trend (Phase 9) with a regression alarm.

**Verify.** Over a 10-run batch, median `toolCallTotal` and `totalTokens` drop vs the Run-1/2 baseline (44/83, 465K/587K) with no quality regression.

**Effort M · deps: Phase 0 telemetry (done), Phase 9.**

---

## Phase 8 — Capability skill-library expansion (open-ended depth)

**Problem (evidence).** Both runs were single-mechanic, 6 files. Arbitrary ideas need composable systems beyond combat (which PR #28 added). The audit catalogued the gaps.

**Goal.** A broad, discoverable, **capability-tagged** skill library so Phase 3's recommender can cover most ideas.

**Concrete changes.** Author, per engine (+ `canvas2d`), with `when_to_use` + capability tags: `level-orchestrator` (multi-scene + transitions), `procedural-gen` (noise/grid for roguelike/sandbox), `animation-sequencer` (sprite/state animation), `save-state` (localStorage persistence/checkpoints), `dialog-flow` (visual-novel/RPG narrative), `mobile-controls` (on-screen + swipe), `economy/tycoon`, `rhythm-clock`. Register in `game-skills/index.ts`; tag each with the capabilities it serves.

**Verify.** A "procedural roguelike" run pulls `procedural-gen` + `level-orchestrator`; a "visual novel" run pulls `dialog-flow`; adoption tracked via Phase 3 telemetry.

**Effort L · deps: Phases 1, 3.**

---

## Phase 9 — Data-driven eval harness on the new telemetry (close the loop)

**Problem (evidence).** Only 6 genre fixtures; **no** novelty/contract fixtures; the just-shipped `run_quality_metrics.report` jsonb is unused by evals. We just learned more from 2 ad-hoc runs than the whole fixture set captures.

**Goal.** Make the new telemetry the evaluation substrate; catch box-escapes, non-adoption, and regressions automatically.

**Concrete changes.**
- New eval dimensions over `report` jsonb: **skill-adoption rate**, **box-escape detector** (decoy-shim / declared-engine ≠ real-engine — i.e. the Run-1 pattern), **contract-coverage** (`contractAuthored` rate), **false-warning rate** on `genre:other`, plus the existing boot/juice/playbook.
- Add **novelty fixtures** (genre-less, drag/ambient/abstract ideas) alongside the genre set; assert they pass via contract + don't escape the box.
- A nightly analyzer that reads `run_quality_metrics.report`, trends per-capability pass-rate + adoption + cost, and files the gaps it finds (it would have flagged Run-2's wave re-derivation and Run-1's box-escape on day one).

**Verify.** The analyzer, run over the two probe rows already in the DB, reports: Run 2 = `wave-spawner recommended-but-unused`; Run 1 = `box-escape (declared phaser, ran vanilla)`.

**Effort M · deps: Phase 0 (done); pairs with 1–4.**

---

## Phase 10 — Open-ended idea intake (the front door)

**Problem (evidence).** Run 2's "neon arena" → `three`/`2.5d` — an engine/spatiality *guess* on an ambiguous brief; the pre-spec ambiguity gate is optional (audit). The front door is where each user's *new, different* idea enters — it must not quietly force a box.

**Goal.** A structured intake that maps any free-form idea → capabilities (Phase 1) + a starter contract (Phase 2), asking **one** high-leverage question only when a core axis is genuinely ambiguous.

**Concrete changes.**
- A first agent step that distils the brief into the capability spec, surfaces the 1–2 axes it had to guess (engine/spatiality/win-condition), and gates on `ask_user` **only** when a core axis is unresolved (make the audit's pre-spec gate real, keyed on capability completeness).
- Seed the starter contract from the distilled capabilities so verification is committed before code.
- Feed intake decisions (which axes were guessed) into the build report for Phase 9.

**Verify.** A batch of deliberately weird prompts produces coherent capability specs + contracts with **no** silent misclassification (no survival→topdown_arcade); the engine/spatiality guess-rate is logged and trends down.

**Effort M · deps: Phases 1–2.**

---

## Metrics (all from the new telemetry)

Track per release, sourced from `run_quality_metrics.report`:
- **Generality:** `contractAuthored` rate ↑, `no_verdict` rate ↓, box-escape rate ↓, false-warning rate on `genre:other` ↓.
- **Adoption:** skill-adoption rate per capability ↑, `recommendedButUnused` ↓.
- **Quality:** booted + `passed` rate ↑, `forceAccept` ↓, juice floor held.
- **Cost:** median `toolCallTotal`, `totalTokens`, `strReplaceFailures`, repair rounds ↓.

Baseline (the two probe runs): tokens 465K/587K, tool calls 44/83, contract-authored 1/2, skill-adoption (systems) 0/2, box-escapes 1/2, false-warnings 1/2. These are the numbers to beat.
