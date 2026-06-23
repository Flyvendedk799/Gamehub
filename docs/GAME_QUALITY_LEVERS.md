# Game-quality levers (from assessing 3 real generated games, 2026-06-23)

Scores (1-5): juicy-arcade loop4/feel4/depth2/polish4 · collectathon-3d loop2/feel2/depth1 · tower-defense loop3/feel2/depth3/polish2.

## Headline finding: ALL 3 GAMES SHIP SILENT
They reference assets/audio/*.wav that were never created → 404 → swallowed by .catch(). Audio = half of game feel, universally absent. Root cause traced to the engine GUIDES (three/phaser told the model to fetch/load phantom .wav paths).

## Lever plan (workflow synthesis + adversarial critique)

I have everything I need. The bootstrap shim is the perfect injection point for an audio-played counter, and there's already a `startMuted` hint flowing through it. I now have full grounding for the systematic analysis and the levers.

---

# Systematic quality gaps + highest-leverage engine levers

## The pattern across all three games

The three failures aren't three bugs — they're **three symptoms of one structural blind spot: the engine grades the *presence of a code pattern*, never the *runtime reality* of audio, depth, or fidelity.** Every gate the games passed checks a regex or a single scalar-changed predicate. None hears silence, sees a flat second wave, or notices an unused engine.

Concrete proof from the codebase (not just the critiques):

- **Audio is verified by regex, not existence.** `assert-game-invariants.ts:217-230` (`FEEDBACK_PATTERNS`) passes the `feedback` invariant the instant `new Audio(` appears in source. It never checks the referenced `.wav` exists in the VFS. All three games emit `new Audio('assets/audio/*.wav')` against files that were never created → 100% silent → all pass. Meanwhile `generate_audio_asset` (which writes a real base64 WAV into the VFS) and the whole `audio-bank/` exist and work — the agent just isn't *forced* to route through them, and there's no penalty for not doing so.
- **The playtest snapshot has no audio-played field.** `gameGlobalSetupSnippet` (runtime `types.ts:215`) tracks any field, the playbooks assert `score`/`playerPos`/`wave` — but `grep` for `audioPlayed`/`soundsPlayed` across the repo returns **nothing**. The deterministic verdict (`scorePlaytest`) and the juice gradient are both structurally incapable of detecting a mute game. juicy-arcade scored 71024 and `PASSED` while completely silent.
- **Depth is one scalar.** `declare_game_spec` captures `escalates`/`hasProgression` as booleans; `assert-game-invariants` only checks a difficulty number drifts up. Nothing requires ≥2 enemy behaviors / a 2nd mechanic / an upgrade. `count=5+wave*3` satisfies every gate. juicy-arcade exhausts its idea-space in 30s.
- **Engine declaration is decorative.** tower-defense and juicy-arcade both declare `engine=phaser`, ship phaser.min.js, then hand-roll Canvas2D — inheriting none of Phaser's free tweens/particles/audio. Nothing reconciles the declared engine against the code that's actually loaded.
- **`shipReason` ships broken games three different ways.** `repair-loop.ts` ships on `no_verdict` (fps collectathon: no pointer-lock check in the playbook fired the gap, but the loop still shipped), `budget_exhausted` (tower-defense: `debugWired=0`, never even ran), and `passed` (juicy-arcade: passed the predicates that exist). The loop only repairs the input→state mapping; it has no lever for "silent / shallow / unverified."

**Weighted by player-perceived harm:** Audio (kills feel on every genre, 3/3 games mute) > Verification-actually-runs (a game that ships unrun is a coin-flip) > Depth (turns a good 30s into a shareable 5min) > Engine-honesty/fidelity (flat primitives read as tech-demo). The fix is overwhelmingly prompt + gate + template + one tiny runtime shim — **no model retraining.**

---

## The levers, ordered by leverage

### Lever 1 — Make audio REAL and VERIFIED: ban raw `new Audio()`, add an audio-played runtime signal, gate on it
**Gap it closes:** The single biggest fun-killer — all 3 games are 100% silent (juicy-arcade laser/pop/hurt/win all 404; collectathon orb-pickup/fall-fail 404; tower-defense hit/coin/base 404). The infra to fix it (`generate_audio_asset`, `audio-bank/`) already exists and is bypassed.

**Concrete change (three small parts):**
1. **Detection fix** — in `assert-game-invariants.ts`, when `new Audio('<path>')` or `.sound.add('<key>')` references a path/key, resolve it against the VFS. A reference to a file that isn't in the design (and isn't a WebAudio-synth/`data:` URL) flips the `feedback` invariant from PASS to **FATAL** ("audio referenced but `assets/audio/laser-shot.wav` was never created — call `generate_audio_asset` or synthesize with WebAudio"). This alone would have failed all three at `done`.
2. **Runtime signal** — in `gameGlobalSetupSnippet` (runtime `types.ts:215`), add `window.__game.debug.audioPlays` (a counter the shim bumps by monkey-patching `Audio.prototype.play` + `AudioContext` start, and tracking 404'd loads). Now the snapshot can prove sound fired.
3. **Gate** — add an `audioPlayed` predicate to the feedback-bearing playbooks (`shmup`, `tower_defense`, `topdown`, `platformer`, etc.): after the fire/hit step, `audioPlays` must have `increased`. Wire it into `repair-loop`'s verdict so a silent game enters a repair round with the instruction "no sound fired during the hit loop — wire `generate_audio_asset` output into your hit handler."

**Quality impact:** HIGH. **Effort:** M (regex-resolve + ~15-line shim + 1 predicate per genre). **Measure:** new `audioPlays > 0` predicate goes green; `audioCalls` (already an observed field in `eval-games.ts:113`) becomes a fixture assertion (`requiredAudio: true` already exists in `fixture.ts:30` — wire it to the runtime signal, not just the tool-call count); re-assessment of the three recordings should move gameFeel +1 each.

---

### Lever 2 — A real "depth floor" in the spec + invariants: ≥2 distinct mechanics/enemy behaviors before `done` can pass
**Gap it closes:** Depth/progression scored 2,1,3 — the dimension that turns "I'd play 30s" into "I'd share this." juicy-arcade has one enemy + one weapon + scalar wave-bump; collectathon has 10 fixed orbs + one timer; the linear `count=5+wave*3` satisfies the *escalation* check while being content-dead.

**Concrete change:** Extend `declare_game_spec`'s `CapabilitiesSchema` with a required-when-completable `contentPlan`: e.g. `distinctEnemyBehaviors` / `mechanicVariety` / `progressionMechanic` (upgrade | new-enemy | new-tool | environmental). Then in `assert-game-invariants`, for "must-ramp" genres, **add an `escalation_is_content` warning→fatal**: a wave system whose only delta across waves is `count`/`speed`/`hp` scalars (no new spawn type, no upgrade pickup, no second weapon) fails. Mirror the existing `escalation` invariant's structure. Add to `game-workflow.v1.txt` step 4: "A complete game introduces a SECOND idea by ~minute 2 — a new enemy behavior, an upgrade, or a new mechanic. Scalar-only escalation (bigger numbers) is a tech demo."

**Quality impact:** HIGH (it's the dimension nothing currently defends). **Effort:** M. **Measure:** a new `assert_game_invariants` predicate (`scalar-only-escalation`); a re-assessment depthProgression delta; add a fixture asserting the spec declares `distinctEnemyBehaviors >= 2` for arcade/shmup/td golden prompts.

---

### Lever 3 — Bind the declared engine to the code that actually runs (kill the decoy-engine pattern)
**Gap it closes:** tower-defense + juicy-arcade declare `engine=phaser`, load 1MB of phaser.min.js, then hand-roll Canvas2D — inheriting none of Phaser's free particles/tweens/audio, which is *exactly* why both shipped flat primitives + broken audio. `choose_engine` and the telemetry tag are disconnected from the source.

**Concrete change:** In `validate_game_scene` (engine-specific lint), add an **engine-honesty check**: if `choose_engine`/spec said `phaser`/`three` but `src/*.js` never references `Phaser`/`THREE` (and instead does `getContext('2d')` + a hand-rolled `requestAnimationFrame`), FATAL — either drop to `canvas2d` honestly or actually use the framework. The codebase already names this the "decoy-engine anti-pattern" in the workflow prose (line 28) but nothing enforces it. Pair with a starter-template tightening (Lever 6).

**Quality impact:** MED-HIGH (forces inheritance of the polish primitives that close visualPolish + half of audio). **Effort:** S (one grep-pair check in the validator). **Measure:** a `validate_game_scene` fatal; telemetry `engine` tag stops lying (cross-check declared vs. detected in the eval recording).

---

### Lever 4 — Close the `no_verdict` / `budget_exhausted` ship-anyway holes
**Gap it closes:** The fps collectathon shipped on `no_verdict` (its playbook's pointer-lock step is English-only, so the missing `requestPointerLock` never tripped a predicate) and tower-defense shipped `budget_exhausted` with `debugWired=0` — **it never ran once.** A "Lovable for games" product cannot ship a game it never booted.

**Concrete change (two parts):**
1. **Make the FPS pointer-lock step machine-checkable.** In `playtest-playbooks.ts` FPS playbook, the click step currently has only an English `assert`. Add a predicate: after the synthetic canvas click, a tracked `pointerLocked` field (exposed by the runtime shim via `document.pointerLockElement`) must be `true`. This deterministically catches the missing `requestPointerLock()` that made collectathon un-turnable. (The collectathon was also mis-genred to `collectathon`; see Lever 5.)
2. **Treat `budget_exhausted` + `debugWired=0` as a hard quality fail, not a ship.** In `repair-loop.ts decideRepairAction`, a `budget_exhausted` ship where **zero** playtest evidence was ever gathered (`noEvidence` AND `roundsRun===0`) should reserve a minimum "boot-and-one-playtest" budget *before* polish, so the validation tail can never be the thing that's starved. Reorder the worker so the mandatory boot+playtest runs early, not in the polish tail.

**Quality impact:** HIGH (an unverified ship is the worst player outcome). **Effort:** M. **Measure:** `pointerLocked` predicate green for fps; `shipReason` distribution in telemetry — `budget_exhausted`-with-no-evidence should drop to ~0; re-run tower-defense recording must show `debugWired=1`.

---

### Lever 5 — Genre-fidelity gate: the input→camera→core-loop chain must match the declared genre
**Gap it closes:** Two of three games had a genre/contract mismatch the spec gate didn't bind. collectathon was tagged `fps` in telemetry but has zero combat (it's a timed platforming collectathon) AND never wired pointer-lock its own HUD advertised. The mismatch is why the most-broken defect (un-turnable camera) slipped through — the wrong playbook was applied.

**Concrete change:** In `game-workflow.v1.txt` / the mechanic-spec block, require the agent to assert the **genre contract** explicitly: "first-person ⇒ MUST call `canvas.requestPointerLock()` on click AND wire `pointerLocked` into debug." Add a small per-genre "contract checklist" that `assert_game_invariants` verifies statically: `fps`/`first_person` perspective ⇒ source must contain `requestPointerLock` (collectathon would have failed: `grep` confirmed it only has `exitPointerLock`). This is the cheapest, highest-certainty catch for the worst single defect across the three.

**Quality impact:** HIGH for the affected genres, MED overall. **Effort:** S (static per-genre required-symbol map). **Measure:** new `assert_game_invariants` rule (`fps-no-pointer-lock`); re-assessment coreLoopFun for collectathon (currently 2 — this defect alone sinks it).

---

### Lever 6 — Polish-floor starter templates: ship feel + a synth-audio path + non-primitive art IN the template, not as a prompt suggestion
**Gap it closes:** visualPolish/gameFeel are uneven (4/2/2) because feel + audio are *opt-in via prompt* (`list_game_feel` step 6, `generate_audio_asset` step 8) and the agent under-uses them under budget pressure. tower-defense ran out of budget mid-polish and shipped flat rectangles in silence; the feel library and audio bank existed and went untouched.

**Concrete change:** Bake a **polish floor into the engine starter templates** (`phaser-engine-guide` / `three-engine-guide` / `canvas2d-engine-guide` + the actual scaffold the `import_skill`/starter emits):
- a **pre-wired WebAudio synth-SFX helper** (`playTone(freq, dur)` — no binary asset, fully within LLM capability) already imported and called from a stub hit handler, so a game is *audible by default* and the agent must actively delete sound to make it silent (inverts the failure mode);
- a **pre-wired feel bundle** (screen-shake + hitstop + particle-burst + score-pop) imported and called once in the template's example hit handler, so feel is the default not the upsell;
- a one-line note that named real-world objects need `generate_3d_asset`/`generate_image_asset` (the asset-fidelity rule already in `game-anti-slop.v1.txt:61`, but promote it into the template so primitive-art is the exception).

**Quality impact:** MED-HIGH (raises the floor on every game, especially budget-starved ones). **Effort:** L (template work across 3 engines + the synth helper). **Measure:** juice gradient floor rises across the golden set; `particleCount`/`activeTweens`/`audioPlays` non-zero by default in fresh recordings; `requireJuice` fixture floor (`fixture.ts:50`) can be raised.

---

## Summary table

| # | Lever | Gap (evidence) | Files | Impact | Effort |
|---|-------|----------------|-------|--------|--------|
| 1 | Real + verified audio (existence check, runtime `audioPlays` signal, gate) | All 3 mute (404 wavs) | `assert-game-invariants.ts`, runtime `types.ts`, `playtest-playbooks.ts`, `repair-loop.ts` | HIGH | M |
| 2 | Depth floor (≥2 mechanics/behaviors; scalar-only escalation = fail) | depth 2/1/3; juicy-arcade one-enemy/one-weapon | `declare-game-spec.ts`, `assert-game-invariants.ts`, `game-workflow.v1.txt` | HIGH | M |
| 3 | Engine-honesty gate (declared engine must be used) | TD+arcade decoy-phaser → flat primitives | `validate-game-scene` | MED-HIGH | S |
| 4 | Close `no_verdict`/`budget_exhausted` ship holes + reserve boot budget | collectathon shipped no_verdict; TD never ran (debugWired=0) | `repair-loop.ts`, worker order, `playtest-playbooks.ts` (fps `pointerLocked` predicate) | HIGH | M |
| 5 | Genre-fidelity contract (fps ⇒ requestPointerLock, etc.) | collectathon un-turnable, mis-genred | `assert-game-invariants.ts`, `game-workflow.v1.txt` | HIGH(genre)/MED | S |
| 6 | Polish-floor templates (synth-SFX + feel + art-fidelity baked in) | feel/polish opt-in, skipped under budget | `*-engine-guide.v1.txt` + starter scaffold | MED-HIGH | L |

**Do levers 1, 4, 5 first** — they're the highest harm-per-effort (audio is the universal fun-killer; 4+5 stop shipping unverified/broken games) and are mostly S/M gate + prompt changes against infrastructure that already exists. Lever 1's audio bank and `generate_audio_asset` are already built and merely bypassed — the win is *enforcement*, not new capability.

Key files referenced: `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/tools/assert-game-invariants.ts` (feedback regex at lines 217-230 — the audio-existence blind spot), `/Users/tobiasmastek/Desktop/Gamehub/packages/runtime/src/engines/types.ts` (debug shim at line 215 — where `audioPlays`/`pointerLocked` get injected), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/playtest-playbooks.ts` (predicates), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/repair-loop.ts` (ship-reason decision), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/tools/declare-game-spec.ts` (capabilities/depth), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/prompts/game-workflow.v1.txt` (steps 6/8), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/tools/generate-audio-asset.ts` + `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/audio-bank/index.ts` (the already-built, bypassed audio path), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/eval/fixture.ts` (`requiredAudio`/`requireJuice` assertions to wire to runtime signals).

---

## Adversarial critique

I have everything I need. The synthesis is largely well-grounded but the critique has corrected several load-bearing claims. Final verdict below.

---

## Verdict: strong synthesis, but three claimed "gaps" are partly already-closed, and the highest-leverage fix is buried in Lever 6.

### What's genuinely grounded (verified in code)

- **Lever 1 (audio).** The core diagnosis is real and verified: `FEEDBACK_PATTERNS` (lines 217–230) passes on the literal presence of `new Audio(` and never resolves the path against the VFS (confirmed: no `.wav`/`exists`/VFS resolution in the feedback check). `audioPlays`/`audioPlayed` return nothing repo-wide (confirmed). `generate_audio_asset` writes a real `data:audio/...;base64` URL into the VFS (line 124) — so it genuinely bypasses the 404. This is the strongest lever and the diagnosis is accurate.

- **Lever 5 (genre contract / pointer-lock).** Highest harm-per-effort and fully grounded. A static `fps ⇒ requestPointerLock` required-symbol map is trivially implementable and deterministically catches the single worst defect (un-turnable camera). Keep this in the first batch.

- **Lever 4 (ship-anyway holes).** Verified: `decideRepairAction` ships on `no_verdict` (line 347), `passed` (352), `budget_exhausted` (356), and `noEvidence` is a real field (line 109/141). The "reserve a boot+playtest budget before polish" reordering is the correct structural fix.

### Weakest / overstated levers

- **Lever 3 (engine-honesty) — partly WRONG as written.** It claims "the codebase names this the decoy-engine anti-pattern in workflow prose but *nothing enforces it*." Enforcement already exists: `assert-game-invariants.ts:530–537` has a `decoy-engine` invariant with `DECOY_ENGINE_PATTERNS`. The real gap is narrower and the plan should say so: the existing check only catches *dead-shim* decoys (`if (false && window.Phaser)`, empty `extends Phaser.Scene {}`) and is **severity: warn**, not fatal. It does NOT catch the actual observed failure — declaring phaser, loading phaser.min.js, then writing a *fully functional* hand-rolled `getContext('2d')` loop with no Phaser dead-code. So Lever 3 is still valid but is an *escalation+broadening of an existing warn*, not a greenfield check. Rescope it: "make decoy-engine fatal + add the loaded-but-never-referenced detection (`<script src=phaser>` present AND `src/*.js` never says `Phaser`)." Effort stays S; the framing was misleading.

- **Lever 6 (polish-floor templates) — mislabeled effort/novelty, and it's actually the highest-leverage item.** Two corrections: (a) the plan implies the synth path is "already built and bypassed" — it is NOT. The audio-bank is **sample `.wav` files + a keyword-lookup** (verified: `manifest.json`, `sfx/*.wav`, no `createOscillator`/synth anywhere in audio-bank OR `game-feel-library.ts`). The `playTone(freq,dur)` WebAudio helper is genuinely new code. (b) More importantly, the synthesis under-ranks this. Lever 1 *enforces* audio but, as the assessments themselves note, "generating real binary .wav is outside an LLM's capability" — so a fatal feedback gate with no easy compliant path risks repair-loop thrashing. The **pre-wired `playTone` synth-in-template is what makes Lever 1's gate cheaply satisfiable** (inverts the failure mode: silent-by-deletion instead of silent-by-default). Levers 1 and 6 are co-dependent; shipping 1 without 6's synth path is the riskiest sequencing decision in the plan. Promote the `playTone` helper into batch 1 alongside Lever 1.

### The high-leverage gap the synthesis MISSED

**No lever closes the loop the assessments actually expose: the model optimizes the self-reported juice score, and that scorer is the thing being gamed.** All three games posted high juice (71024 / 96 / 96) while being silent/shallow/unrun. The plan adds *new* gates (audio, depth, pointer-lock) but never touches the **incentive** — the juice metric remains a pure visual-particle sum with no audio/depth/verification term, so the model will keep steering toward whatever the scorer rewards. Every proposed gate is a downstream tripwire; none re-weights the upstream objective. A `juiceScore` that folds in `audioPlays>0`, `distinctBehaviors`, and `evidenceGathered` (even as multipliers that zero-out a silent/unrun game) is higher-leverage than any single predicate, because it changes what the model *aims at* rather than adding a wall it learns to climb around. This is the one structural lever missing, and it's consistent with the synthesis's own stated root cause ("optimizes for what the juice gradient rewards").

### Verbosity risk (the "model already ignores prose" test)

- Lever 2's prompt addition ("introduce a SECOND idea by minute 2…") is exactly the kind of escalation guidance the games **already underused** — the synthesis flags this risk for others but commits it here. The *gate* half of Lever 2 (`scalar-only-escalation` → fatal: wave delta is only `count`/`speed`/`hp`) is the load-bearing part and is grounded. Drop the prose line or treat it as cosmetic; the invariant is what moves the needle.
- Lever 5's workflow prose ("first-person ⇒ MUST call requestPointerLock") is similarly redundant with the static check — keep the static map, the prose is optional.

### Recommended re-ordering

1, 6-synth-helper, 5, 4 first (audio gate + its compliant path + the two unverified-ship fixes). Then 2-as-gate-only and 3-as-escalation. Add the **missing juice-scorer re-weighting** as the sleeper high-leverage item.

Key files (all verified): `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/tools/assert-game-invariants.ts` (feedback regex 217–230 = real blind spot; decoy-engine check ALREADY at 530–537 = Lever 3's claim is wrong), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/tools/generate-audio-asset.ts` (data-URL WAV at line 124), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/audio-bank/index.ts` + `manifest.json` (samples, NOT a synth — Lever 6's `playTone` is new), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/tools/game-feel-library.ts` (no synth/playTone), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/repair-loop.ts` (ship reasons 347/352/356, `noEvidence` 109/141), `/Users/tobiasmastek/Desktop/Gamehub/packages/core/src/eval/runner.ts` (lines 131–135: `requiredAudio` gates on tool-call count, not runtime — the plan's "wire to runtime signal" rewire target), `/Users/tobiasmastek/Desktop/Gamehub/services/worker/src/run-generation.ts` (Lever 4's reorder target).

---

## Implementation status
- **Lever 1 (audio) + Lever 6 (synth path) — SHIPPED (this batch):** three/phaser engine guides rewritten to teach in-code WebAudio synth (zero assets) + "never reference a .wav you did not create"; canvas2d already taught synth. Backstop: new `silent-audio` advisory invariant (resolves audio refs against the VFS). Kept advisory (the guide change is the default-changer; promote to repair only if runs still go silent).
- **Lever 5 (fps pointer-lock) — SHIPPED:** new `fps-no-pointer-lock` advisory invariant (mouse-look source must call requestPointerLock).
- **Remaining (next batches):** L2 depth-floor gate (scalar-only-escalation = fail), L3 decoy-engine escalation (warn→fatal + loaded-but-unreferenced engine), L4 close no_verdict/budget_exhausted ship-holes + reserve boot+playtest budget, and the MISSED lever — re-weight juiceScore to fold in audioPlays/depth/evidence so the model optimizes for the right objective (needs an audioPlays runtime signal first).
