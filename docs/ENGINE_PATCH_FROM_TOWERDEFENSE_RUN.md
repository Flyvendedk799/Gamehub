# Engine patch focus — learnings from the first live tower-defense run

**Source:** the first real end-to-end generation on the live deploy
(playerzero.online), prompt *"Create a simple tower-defense game where the enemies
are chickens…"*, Phaser engine. Two runs on the same project tell the whole
story:

| Run | ship_reason | playbook | juice | runtime_booted | what it means |
| --- | --- | --- | --- | --- | --- |
| initial (`5c79c0c8`) | **`no_verdict`** | **0 / 0** | 276 | true | shipped **unverified** — the playtest could not read game state |
| user "Fix the bug" (`1b5b8a73`) | `passed` | **4 / 4** | 100000 | true | properly verified after the human caught the bug |

The headline: **the engine shipped a game it never actually playtested, and that
game then crashed in front of the user.** The human had to notice, click "Fix the
bug", and only *then* did the pipeline produce a verified result. Everything below
is an engine-level cause that will recur on every game until fixed — none of it is
specific to tower defense.

---

## P0 — The `window.__game` runtime contract is unsafe on both sides

This one caused **both** the shipped crash **and** ~10 wasted repair turns.

**Evidence (the actual shipped bug, diagnosed in the fix run):**
> "The crash was caused by `_installSnapshot()` trying to assign
> `window.__game.debug.snapshot` without first checking that `window.__game.debug`
> actually exists and is writable — when the host runtime injects its own
> `window.__game` object after the module loads, `debug` could be absent, sealed,
> or ha[s a getter]."

**Evidence (the verify harness, initial run — ~10 turns burned):**
> "The error 'Cannot read properties of undefined (reading controls)' with
> 'window.__game never appeared'… This is a host bootstrapping issue — the game
> will work in the actual host."
> "the verify sandboxed environment may not [inject window.__game]."

**Root cause.** There is no enforced contract for *who* creates `window.__game`,
*when*, and *which sub-objects* (`debug`, `controls`) are guaranteed writable. The
generated game assumes it can freely read/write `window.__game.debug.snapshot`;
the host injects its own `window.__game` *after* the module evaluates; and the
**verify sandbox doesn't inject the shim at all**, so it reports false
"never appeared" / "0 interactive state changes" errors on correct games.

**Fix.**
1. Runtime bootstrap must create `window.__game` **and** `window.__game.debug`
   (a plain, writable object) **before** the game module is evaluated — same in
   the real preview iframe *and* the verify/playtest sandbox. Today they differ;
   that difference is the bug.
2. Ship a defensive idiom in the game template / system prompt so generated code
   never assumes: `window.__game ||= {}; window.__game.debug ||= {};` before any
   assignment, and treat `controls.define` as optional-chained.
3. `verify_artifact` must load the artifact through the *same* bootstrap as the
   host. A verifier that can't reproduce the host environment produces false
   negatives the agent then "fixes" by damaging correct code.

**Why it matters most:** it is simultaneously the crash the user hit, the reason
the verifier lied, and a token sink (~10 turns of the agent chasing a
non-existent module-load bug on the subscription).

---

## P1 — The playtest can't get past a Title/menu scene → ships `no_verdict`

**Evidence (fix run):**
> "The playtest runs from the **TitleScene** boot state — it never clicks
> 'start', so `_dbgScene` stays `null` the whole time. The snapshot returns zeros
> for everything."

**Root cause.** The playbook issues its `wait` / `pointerDown` steps while the
game is still on the title screen. Nothing advances to `PlayScene`, so
`__game.debug` never populates, the playbook scores **0/0**, and the run ships
with `ship_reason = no_verdict`. A menu screen — which almost every game has —
blinds the entire verification layer.

**Fix.** Give the playtest a reliable way into the primary play state, in
priority order:
1. A standard runtime hook the harness calls first, e.g.
   `window.__game.playtest.begin()`, which every generated game wires to "skip to
   the main playable scene."
2. Failing that, the harness auto-advances: synthesize a click/Enter on boot and
   detect the scene transition before starting assertions.
3. Guardrail: generation must expose `__game.debug` state from the very first
   interactive scene, not only after a menu.

---

## P2 — Fixed-frame `wait` steps race the game's own pacing

**Evidence (fix run):**
> "the game waits `waveCountdown` seconds (starts at 2s) before the first wave.
> The playtest's `wait` frames (default 60 frames = ~1s at 60fps) may not be
> enough to wait through 2 seconds of countdown."

The agent's workaround was to **shorten the game's countdown to fit the test** —
i.e. it changed the game to satisfy the harness. That's backwards.

**Root cause.** Playbook steps wait a fixed number of frames; per-game pacing
(countdowns, spawn delays, animations) varies widely, so assertions fire before
the observable change happens.

**Fix.** Make playbook waits **condition-based with a timeout**: "advance until
`enemies > 0` (or ≤ N seconds)", "until `score` increases", etc., instead of
"wait 60 frames". Condition waits are robust to any pacing and stop the harness
from dictating game design.

---

## P3 — Static validators throw false positives that force worse code

Two separate checkers made the agent *rewrite working code into a worse shape*:

**`validate_game_scene` — runtime-baked textures not recognised:**
> "The validator flags `this.add.image()` calls without a matching
> `this.load.image()`. These textures are baked at runtime via
> `textures.addCanvas(key, cv)` — they ARE valid… I'll render everything with
> `Graphics` objects instead."

Result: 6 false "errors", three rewrite rounds, and the game's art pipeline
downgraded from baked canvas textures to immediate-mode `Graphics` purely to
appease the linter.

**`assert_game_invariants` — narrow input-binding pattern match:**
> "The invariant checker does pattern-matching and may not see the
> `keyboard.once('keydown-R'…)` form. Let me also add it to `PlayScene`… so the
> checker picks it up."

Result: redundant duplicate key bindings added just to match a regex.

**Fix.** Broaden both:
- `validate_game_scene` texture-existence must accept runtime texture creation
  (`textures.addCanvas`, `textures.createCanvas`, `generateTexture`, documented
  `bakeTexture` helpers) as valid sources, not only `this.load.*`.
- `assert_game_invariants` input detection must cover `.once('keydown-…')`,
  `.on('keydown-…')`, `input.keyboard.addKey`, and pointer handlers — ideally via
  a small AST pass rather than string patterns.

**Why it matters:** false positives don't just waste turns — the agent
"satisfies" them by degrading the output, so the checker actively lowers quality.

---

## P4 — `no_verdict` must not count as a clean ship

Run `5c79c0c8` shipped with `playbook 0/0`, `ship_reason = no_verdict`, and then
crashed. The pipeline treated "couldn't test it" the same as "tested and fine."

**Fix.** Treat `no_verdict` as a **soft-fail that triggers one more repair round**
aimed specifically at playtest-reachability (P1) — i.e. "make the game testable,
then test it" — before allowing `done`. If a verdict still can't be produced,
surface it loudly on the project instead of shipping silently. The contrast is
stark: the run with a real 4/4 verdict was clean; the run with no verdict shipped
a crash.

---

## Suggested patch order

1. **P0** — fix the `window.__game` bootstrap contract (host + verify sandbox
   identical; defensive template idiom). Removes the crash *and* the biggest
   turn/token sink.
2. **P1 + P4** — playtest must enter the play scene, and `no_verdict` must block
   `done`. Together these stop unverified games from shipping.
3. **P2** — condition-based playbook waits.
4. **P3** — widen the two static validators so they stop forcing worse code.

## Efficiency note

Beyond quality, the initial run burned roughly a dozen turns on P0/P3 false
signals (verify_artifact "never appeared" ×5, validate_game_scene rewrites ×3,
invariant duplication). On a metered/subscription budget that is real money per
game and a slower UX. Fixing P0 and P3 shortens every future run, not just the
buggy ones.
