# PlayerZero Engine Evolution v3 — a 10-Phase Plan (data-rooted)

> **North star (unchanged).** "Lovable for games": generate *any* user idea well,
> not box-fit.
>
> **What changed.** v1 made capabilities *discoverable*; v2 made them *executable*
> (`import_skill`), gave the verdict layer a real `debug.snapshot`, and shipped a
> first-class `canvas2d` engine. **Loop-3 (8 runs through the deployed v2 engine)
> proved those fixes landed** — but v2's *success* newly exposed the next layer of
> gaps. v3 attacks exactly those: the telemetry went **blind to `import_skill`**
> (we can't even score P1), skills get **imported-but-never-used**, and `canvas2d`
> ships **honest but un-verified**.

Rooted in **loop-3**, the validation batch that re-ran the exact scenarios v1/v2
had failed. Synthesized by a 6-lens workflow and hardened by an adversarial
critique that verified every load-bearing `file:line` citation against the tree.

---

## 0. Evidence base — loop-3 (v2 in action)

### Before → after (loop-3, 7 completed, vs the N=19 v1 baseline)

| Signal | v1 baseline | Loop-3 (v2) |
|---|---|---|
| Skills imported **+ called** (`usesSkillFns`>0) | 0/19 | **5/7** |
| `debug.snapshot` wired | 0/19 | **5/7** |
| `import_skill` adopted | — | **6/7** |
| Box-escape / decoy | 1/8 | **0/7** |
| `no_verdict` / `repair_exhausted` | ~4/8 | **0/7** |

**The v2 fixes landed.** v3 is about what loop-3 *newly* revealed.

### Per-run (loop-3)

| Idea | engine / ship | tokens | import_skill / usesSkillFns / debugWired | tell |
|---|---|---|---|---|
| tide-boats (ambient) | **canvas2d** / passed | 379K | 0 / 0 / 0 | honest canvas2d pick (was an 853K decoy) — but no snapshot, `score-or-state` warn |
| tower-defense | phaser / **passed** | 468K | 2 / 2 / 2 | was `repair_exhausted`; **but `recommendedButUnused`=5 while it imported 2** (telemetry blind) |
| rhythm | phaser / passed | **898K** | 3 / 5 / 0 | imported+called rhythm skills; no snapshot; most expensive |
| visual-novel | **canvas2d** / skipped_non_completable | 718K | 1 / 2 / 1 | a *text* game steered onto a raw canvas |
| survival-shooter | phaser / passed | 556K | 2 / **25** / 2 | best run — heavily imported+called enemy-ai+wave-spawner (was 0) |
| roguelike | phaser / passed | 403K | **3 / 0 / 1** | **imported 3 modules, called 0** (wrote dead files, hand-rolled instead) |
| platformer | phaser / passed | 332K | 2 / 8 / 1 | imported save-state (was re-deriving via raw localStorage); cheapest |
| idle-clicker | **canvas2d** / paused | 801K | 3 / 0 / 0 | a *UI* game steered onto a raw canvas; staged-and-abandoned |

### Findings that drive v3

1. **The adoption telemetry is blind to `import_skill`.** `run-signal.ts` only adds to `skillsViewed` on `view_game_feel`; `recommendedButUnused = recommended − skillsViewed`. So every *imported* skill is mis-counted "unused" — tower-defense shows 5 unused while it imported 2, and the runs that adopted *hardest* (survival 25, platformer 8) light up the "missed adoption" flag. **We cannot score whether P1 worked.**
2. **Import-without-use gap.** Roguelike + idle ran `import_skill` 3× with `usesSkillFns=0` — wrote modules to disk and never imported/called them. Worse than not importing: tokens paid, dead code shipped, system hand-rolled anyway.
3. **The decisive signals live only in a hand-grep.** `usesSkillFns`/`engineImports`/`debugWired` exist *nowhere* in the persisted report — the loop-3 table was assembled by hand. The most decision-relevant fact (the gap above) is invisible to the data.
4. **`canvas2d` is honest but un-verified.** All three canvas2d runs are the worst-instrumented (no snapshot, `score-or-state` warns, lean on `skipped_non_completable`) — because **there is no `canvas2d` engine guide** and its only verdict source (a contract) is never enforced.
5. **`recommendEngine` over-steers DOM/text/UI genres onto a raw canvas.** A text-heavy VN and a UI-heavy idle both went `canvas2d` (they want DOM/text/buttons) — the fingerprint can't tell them from the genuinely-ambient tide game. These were the two most expensive non-rhythm runs.
6. **Cost is measured wrong.** Every "cost" figure is raw `totalTokens`, ignoring cache economics (cached input bills ~10× cheaper; `computeImpliedCost` already exists but the analyzer never calls it). The 898K "outlier" may be a measurement artifact.

**Thesis:** *fix the measurement before trusting any future loop's numbers*, then close the import→use→verdict path the canvas2d ship opened.

---

## Sequencing (per the adversarial critique)

```
FIRST — honest measurement (cheap, unblocks everything):   1 · 2 · 7 · 10a
THEN  — the import→use→verdict cluster (ONE workstream):    3 · 4 · 8 · 9
THEN  — precision:                                          5 · 6
LAST  — net-new feature:                                    10b
```

> The critique's load-bearing note: **Phases 3/4/8/9 are one coordinated
> workstream, not four independent phases.** Phase 4's invariant *consumes* Phase
> 2's signal (don't re-grep); Phases 8 and 9 edit the **same** `decideRepairAction`
> branch and must ship as **one condition**. They're numbered separately for
> clarity but planned as a unit.

Each phase: **Problem (evidence) → Concrete changes → Verify → Effort/leverage.**

---

## Phase 1 — Make adoption telemetry `import_skill`-aware *(ship first)*

**Problem (evidence).** `run-signal.ts:54-57` adds to `skillsViewed` only on `view_game_feel`; `recommendedButUnused` (`run-generation.ts:732-734`) subtracts that set; the analyzer's `missedAdoptionRate` + "low adoption" flag (`run-report-analysis.ts:318-322`) are now **pure noise**. Tower-defense imported 2 and called 2 yet reports `recBU=5`; the best runs (survival 25, platformer 8) report "missed adoption." 6/7 runs used `import_skill`, captured by none of it.

**Changes.**
- `run-signal.ts`: add a `skillsImported` set to `createRunSignalAggregator`; **populate primarily from `tool_execution_end` → `result.details.name`** (`ImportSkillDetails` always carries it; the start-event `args.name` shape is unverified — use it only as a fallback). Emit `skillsImported` in `RunSignal`.
- `run-generation.ts:732`: compute `recommendedButUnused` against the **union** of `skillsViewed` + `skillsImported`. **Normalise the name form** on both sides (`recommendSkills` emits `phaser/wave-spawner.js`; the imported name is whatever the agent passed) or the subtraction still mis-counts.
- `run-report-analysis.ts`: add `skillsImported` to `BuildReport`; make `agentAdoptedSkill` test the union so `adoptionRate`/`missedAdoptionRate` read true.

**Verify.** Re-derive `skillsImported` from each loop-3 run's `toolCalls` and re-run `analyzeReports`: tower-defense `recBU` drops 5→≤3, the best runs flip `missedAdoption` true→false. Unit-test the aggregator on a synthetic `import_skill` event stream.

**Effort S · leverage high.**

## Phase 2 — Persist the code-usage signals into the report *(ship first)*

**Problem (evidence).** `usesSkillFns`/`engineImports`/`engineFilesWritten`/`debugWired` exist only as out-of-band hand-greps — there is zero FS/code inspection in the worker telemetry path. The single most decision-relevant fact, the import-without-use gap (roguelike `import_skill=3, usesSkillFns=0, engineImports=0`; idle the same), is invisible to the data.

**Changes.**
- New pure `services/worker/src/skill-usage-grep.ts` scanning `tree.toTextFiles()` (`WorkingTree.toTextFiles()` exists — zero extra I/O): `engineFilesWritten` (count `src/engine/*.js`), `engineImports` (files importing `./engine/`), `usesSkillFns` (an imported export counts as called only when matched as `\bNAME\s*\(` **and** the file also imports `./engine/<base>.js` — avoids comment/string/same-name false positives), `debugWired` (the `SNAPSHOT_WIRING_PATTERNS`), and **`skillImportedNotCalled: string[]`** (the actual dead skills — the named list Phase 4 + the analyzer need).
- `run-generation.ts` build report: add these + derived `importWithoutUse`.
- `run-report-analysis.ts`: add the fields + an `isImportWithoutUse` detector + an `importAdoptionRate` (usesSkillFns>0 over runs with skillsImported>0).

**Verify.** Unit-test the grep against fixtures reproducing survival (engineImports=3/usesSkillFns=25), roguelike (0/0), platformer (8); assert `importWithoutUse` true for roguelike/idle, false for survival/platformer; assert the 8-run analyzer reproduces the loop-3 hand table.

**Effort M · leverage high.**

## Phase 3 — Auto-wire the import (commented stub, never an active edit)

**Problem (evidence).** `import_skill` writes the module then returns "add this import and CALL the exports" as **plain text** (`import-skill.ts:118`) — the weakest enforcement. Adoption is bimodal: runs 5/7 wired it manually, runs 6/8 ignored it. The import line is a deterministic edit the tool already computes (`canonicalImportPath`/`importFrom`).

**Changes (de-risked per critique).**
- `import-skill.ts`: after `fs.create`, locate an entry that already imports `./engine/` **or** the `src/main.js` convention. If found, **prepend a COMMENTED stub only** — `// import { createWaveSystem } from './engine/wave-spawner.js'; // <- uncomment + call` plus a call stub — so an auto-edit can **never** break a booting game (an active mis-located import 404s/shadows; a comment can't). The agent activates it.
- If no entry is found, fall back to today's text-only path + return "module written (entry not found — add manually)".
- Result text distinguishes "stub wired into `<entry>`" vs "entry not found."

**Verify.** Unit-test with a fake FS containing `src/main.js`: the commented stub is prepended and not duplicated on re-import; graceful "entry not found" path. Sequence **after** Phase 2 so `importWithoutUse` measures whether it closed the gap.

**Effort M · leverage high.**

## Phase 4 — `skill-staged-unused` invariant (consumes Phase 2's signal)

**Problem (evidence).** Nothing verifies an imported module is ever used. Roguelike imported 3, used 0, and *also* fired `inv=[score-or-state,controls,escalation]` — it hand-rolled the exact systems it had staged. The module is dead weight that *hides* the re-derivation.

**Changes (merged into the Phase 2/3 workstream).**
- `assert-game-invariants.ts`: consume Phase 2's `skillImportedNotCalled` list (do **not** re-grep — that's a second drift-prone scan). For each still-dead skill, push a warn `skill-staged-unused` ("you imported `<skill>` to `src/engine/<base>.js` but never call it — uncomment the import + call `<export>()`, or you're paying for dead code while hand-rolling the same system"). It surfaces in `invariantWarnings` and feeds the existing repair-instruction branch.
- Scope it to fire **only** when the (post-Phase-3) stub/import is absent — it backstops the entry-not-found / multi-entry case, not the happy path.

**Verify.** Unit-test: `src/engine/wave-spawner.js` present but never called → warn; import + a `createWaveSystem()` call → no warn; warning present for the roguelike fixture, absent for survival.

**Effort M (as part of the cluster) · leverage high.**

## Phase 5 — Tier the recommender (top-N import-now vs also-available)

**Problem (evidence).** `recommendSkills` emits one rec per matched rule with no cap or priority — tower-defense fires 5 simultaneous "import this" imperatives. *(Critique: the "long lists hurt adoption" claim is thin — TD passed and wired 2 of 5. Reframe.)*

**Changes (reframed per critique).** This is **telemetry hygiene, not an adoption fix**: attach a priority weight per rule (genre-canonical > core-loop > save/progression > polish); `formatRecommendationsForPrompt` shows the top 2-3 as "import now" + the rest as "also available"; only the import-now tier counts toward `recommendedButUnused` so post-Phase-1 telemetry isn't penalised for a skipped 5th polish skill.

**Verify.** Unit-test tower-defense yields ≤3 import-now recs (economy/wave/enemy ahead of save/polish). Only ship the tiering if, after Phases 1-4, re-scored loop-3 still shows over-push.

**Effort S · leverage low-medium.**

## Phase 6 — Stop over-steering DOM/text/UI genres onto a raw canvas

**Problem (evidence).** `recommendEngine` (`game-spec.ts:384-395`) fires for *any* 2D pointer/drag with no enemies/physics — indistinguishable between the ambient tide game and a text VN / UI idle. `checkEngineFit` then rubber-stamps `canvas2d` "ok" for any non-3D. Result: VN→canvas2d (718K, skipped) and idle→canvas2d (801K, paused), the two most expensive non-rhythm runs; only the genuinely-ambient tide game (379K, passed) was a correct pick.

**Changes.**
- `recommendEngine`: **skip** the canvas2d steer for `visual_novel | idle | tycoon` (and dialogue/menu `other`); steer canvas2d **only** with a positive ambient signal (`mechanics` includes guide/flow/grow/paint) **and** the absence of a bundled-playbook genre — so engine pick and verdict source stay consistent.
- `checkEngineFit`: return `warn` (not `ok`) for `canvas2d` + `{visual_novel,idle,tycoon}` — and **verify the `warn` verdict is actually surfaced to the agent at pin time** (a warn nothing reads is inert).
- Route `hasNarrative`/`hasEconomy`/text-UI genres to phaser (which has VN+idle playbooks) until a DOM engine exists (10b).

**Verify.** Unit-test: `recommendEngine` returns null for VN + idle, still returns canvas2d for the tide fingerprint; `checkEngineFit` warns for canvas2d+visual_novel.

**Effort S · leverage high.**

## Phase 7 — Author `canvas2d-engine-guide.v1.txt` *(ship first)*

**Problem (evidence).** `composeGame` pushes only the three/phaser guides (`prompts/index.ts:2236-2237`) — there is **no canvas2d arm**. Every canvas2d run is generated with only the generic workflow: no skeleton, no `debug.snapshot` pattern, no state convention. This is the upstream cause of every canvas2d defect (no snapshot, `score-or-state` warns). It's the cleanest cause→effect in the plan and the lowest-risk net-new file.

**Changes.**
- New `packages/core/src/prompts/canvas2d-engine-guide.v1.txt` modelled on `PHASER_ENGINE_GUIDE`: a raw-canvas skeleton (`getContext('2d')` + `requestAnimationFrame`, matching `canvas2d.ts`'s validator), a **mandatory** `window.__game.debug.track({...})` wiring line, and an ambient state-signal convention so a measurable field is always exposed.
- Register in `PROMPT_SECTIONS`/`PROMPT_SECTION_FILES` + add `else if (engine === 'canvas2d')` at `index.ts:2237`; update the line-1162 note.
- **The guide must teach `import_skill` for canvas2d** (today `recommendSkills` skips canvas2d via `run-generation.ts:729` + is hard-typed `Engine='phaser'|'three'`): either widen the recommender with a canvas2d arm or hand-list the engine-agnostic skills (save-state, economy-system) a canvas2d game should import — else canvas2d stays skill-blind even with the guide.

**Verify.** `composeGame({engine:'canvas2d'})` snapshot test asserts the guide is present (absent for phaser/three); lint the skeleton with `assertGeneratedJavaScriptSyntax`; a follow-up loop should flip canvas2d `debugWired` toward 1.

**Effort M · leverage high.**

## Phase 8 — Make `canvas2d` verifiable (contract gate + decouple the snapshot invariant)

**Problem (evidence).** canvas2d has no playbook (by design), so its only verdict source is a volunteered contract — but nothing enforces it, and two escape hatches swallow it: the `debug-snapshot` invariant only fires when `hasFailState===true` (`assert-game-invariants.ts:453`), exempting ambient toys; `decideRepairAction` step (1) ships `skipped_non_completable` unless `contractAuthored`. All three canvas2d runs failed to reach a contract-gated `passed` (tide shipped boot-only with no machine-checkable state).

**Changes.**
- `run-generation.ts` done-path: when `engine==='canvas2d'` and `contract===null`, **block `done`** with an instruction to call `declare_playtest_contract` (the completability-floor blocking pattern).
- `assert-game-invariants.ts`: change `wantsVerdict` to also fire when the spec declares *any* measurable state (score-or-state present OR a contract references a snapshot path) so ambient canvas2d toys still must expose `debug.snapshot()`.
- `choose-engine.ts` canvas2d branch: a HARD directive that `declare_playtest_contract` is required next.
- *(The repair-loop edit is folded into Phase 9 — see below.)*

**Verify.** done-gate test blocks a canvas2d tree with no contract; `assertGameInvariants` fires `debug-snapshot` for a stateful canvas2d game with `hasFailState=false`.

**Effort L · leverage high.**

## Phase 9 — Score the bundled VN/idle/sandbox playbooks (one repair-loop edit with P8)

**Problem (evidence, corrected per critique).** v2 backfilled real predicate playbooks for visual_novel/idle/sandbox — but those genres are in `NON_COMPLETABLE_SPEC_GENRES`, so `contractAuthored` is permanently false for them, and `decideRepairAction` step (1) ships `skipped_non_completable`. **The score IS computed** (`observeVerdict` runs the playbook) — it's then **discarded** by the escape. (The fix is in the *consumer* `decideRepairAction`, not the producer.) Separately, `buildRepairVerdict` treats `score===null` as pass, so a playbook can "pass" with no live snapshot (rhythm passed with `debugWired=0`).

**Changes.**
- **One coordinated edit to `decideRepairAction` step (1)** (subsumes Phase 8's repair edit): the `skipped_non_completable` escape fires only when **(non-completable genre AND no playbook predicates ran AND no contract authored)**. That single condition lets canvas2d-with-contract fall through (P8's goal) *and* VN/idle-with-scored-predicates fall through (P9's goal) — writing them separately invites a merge conflict.
- `observeVerdict`: when a playbook has predicates but the browser-worker reports `hasDebugContract=false`, treat it as fatal-equivalent so the repair instruction says "wire `debug.track`" instead of crediting a pass. *(Verify `PlaytesterOutput.hasDebugContract` exists before relying on it.)*

**Verify.** Unit-test `decideRepairAction`: VN + score non-null → pass/repair (not skipped); idle + score null + no contract → still skipped; a rhythm-like run with predicates but `hasDebugContract=false` → repair instruction, not "passed."

**Effort M (with P8) · leverage high.**

## Phase 10a — Cache-weighted `costUsd` in the report *(ship first)*

**Problem (evidence).** Every loop-3 "cost" is raw `totalTokens`, ignoring cache economics (cached input ~10× cheaper). `usedCacheReadTokens`/`Write` are tracked (`run-generation.ts:354-355`) but dropped from the report; `computeImpliedCost` (`pricing.ts:223`) does correct cache-weighting but nothing in the analyze path calls it (`isCostly` sorts `totalTokens`). The 898K rhythm "outlier" may be an artifact — and there are **two divergent token definitions** (worker = uncached input+output; agent = full-weight incl. cacheRead/Write).

**Changes.** Build report adds `costUsd`, `cachedInputTokens`, `cacheCreationInputTokens`, `cacheHitRate` via `computeImpliedCost`; `isCostly`/the high-token flag sort by `costUsd` p90; reconcile the worker-vs-agent `totalTokens` definition to one.

**Verify.** Re-score loop-3 by `costUsd`: assert the canvas2d outliers compress toward the platformer baseline once cacheRead is down-weighted (quantifies whether 898K is real cost or artifact).

**Effort S · leverage high.**

## Phase 10b — Cloud-save persistence *(deferred net-new feature)*

**Problem (evidence).** The only persistence primitive is `localStorage` (`save-state.js`) — per-browser-device — but the product is cloud-native, so idle/RPG/roguelike meta-progression can only be faked (platformer "fixed" its save but it's still device-local; idle, whose *identity* is persistent accumulation, got no save).

**Changes.** New `cloud-save` skill (phaser + three) using a sandbox-safe persistence API via the `__game` postMessage bridge (host writes a per-project/per-account store, honouring `connect-src 'self'`); `recommend-skills.ts` prefers `cloud-save` over `save-state` for `hasProgression`/`idle`.

**Verify.** Unit-test the recommender prefers `cloud-save`; integration-test the postMessage save round-trips under a `connect-src 'self'` CSP. *(Depends on host bridge work — defer behind the measurement story.)*

**Effort L · leverage medium.**

---

## Metrics (all from the corrected telemetry)

Track per release from `run_quality_metrics.report` (Phases 1/2/10a make these *true* for the first time):
- **Import adoption:** `importAdoptionRate` (usesSkillFns>0 | skillsImported>0) → ~1.0; `importWithoutUse` rate → 0.
- **Telemetry honesty:** `recommendedButUnused` reflects imports (TD 5→≤3); the best runs stop firing "missed adoption."
- **canvas2d quality:** `debugWired` on canvas2d runs 0→~1; canvas2d reaches contract-gated `passed`; off-genre canvas2d steers (VN/idle) → 0.
- **Verification:** VN/idle/sandbox earn real play-verdicts (not `skipped_non_completable`).
- **Cost:** ranked by `costUsd`, not `totalTokens`.

## Adversarial-critique verdict

"**Genuinely data-rooted and worth shipping — with sequencing fixes.**" Every load-bearing citation verified against the tree; **none of the 10 phases retreads v1/v2** — each targets a gap created *by* the v2 ships. Applied fixes: ship **1·2·7·10a first** (fix measurement before trusting any future numbers); plan **3·4·8·9 as one workstream** (Phase 4 consumes Phase 2's signal; Phases 8+9 share one `decideRepairAction` condition); Phase 3 writes a **commented stub only** (never a boot-breaking active edit); Phase 5 reframed as telemetry hygiene (not an adoption fix); Phase 9's framing corrected (score is *discarded*, not "never computed"); Phase 10 split into **10a** (cost lens, early) + **10b** (cloud-save, deferred).
