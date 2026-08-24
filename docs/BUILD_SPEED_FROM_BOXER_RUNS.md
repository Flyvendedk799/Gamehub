# What three identical builds taught us

Three production runs, byte-identical prompt, measured end to end. Every number
below is from `runs`, `run_events` and `run_quality_metrics` — none of it is
estimated.

| | `8e064664` | `d1567c9a` | `6ea60c10` |
| --- | --- | --- | --- |
| wall clock | 16.8 min | 24.9 min | **16.5 min** |
| output tokens | 55,280 | 71,222 | **42,302** |
| edit-tool model latency | — | 819 s | **405 s** |
| …per call | — | 10.0 s | **5.3 s** |
| `find` calls | 0 | 0 | **18** |
| views of `src/main.js` | 45 | 35 | 37 |
| ranged views | 44 | 47 | 35 |
| `symbol` views | 0 | 1 | 1 |
| `str_replace` failures | 7 | 2 | 5 |
| tool calls | 105 | 140 | 115 |
| juice score | 96 | 96 | 91 |
| shipped lines (`main.js`) | ~1000 | 745 | 1419 |

Run 2 was a regression we caused and reverted. Run 3 carries the navigation
work. **Per-call edit latency halved**, and it shipped a game roughly twice the
size for 41% fewer output tokens than run 2.

---

## What we already learned, and should not re-learn

### Recommending a capability does not make it used

Run 2 added `three/engine-core` to the skill recommender. It was imported,
read across nine `view` calls, **never called**, and deleted by the dead-skill
sweep. `skillsImported` rose; `usesSkillFns` stayed 0. Cost: eight minutes.

By the time a recommendation is read the agent has committed to its own
architecture. Feature skills bolt on; a foundational loop cannot. The signature
to watch for is **`skillsImported` rising while `usesSkillFns` stays 0**.

### A precise tool nobody can find is a tool nobody uses

`view symbol=` existed for months. Across runs 1 and 2 it was used **once**,
against 91 ranged views — because using it requires already knowing the name,
and nothing told the agent what was in the file. Attaching the map to every
view (run 3) is what made `find` land at 18 uses immediately.

**Rule: capability + discovery, or it does not ship.** Anything optional that
requires prior knowledge to invoke will not be invoked.

### A test double that is kinder than production hides real bugs

`str_replace` recovery was gated on matching an error string only the in-repo
double produced. Tests passed; the path was dead in production for every run.
Classify from state, never from message text — and word doubles exactly as the
real implementation does.

---

## What run 3 says to do next

Ordered by measured cost, not by appeal.

### 1. The game is one 1419-line file, written in a single 52 KB `create`

`src/main.js` was created in **one call carrying 52,334 bytes**, then edited
17 times (10 `str_replace`, 7 `patch`) with 37 views interleaved. Every
consequence of that is expensive:

- The first write is one enormous output burst with no checkpoint.
- Every subsequent edit targets a file too large to hold in working memory, so
  it needs a look first — hence 37 views for 17 mutations, still better than
  2:1.
- A single-byte edit invalidates the prompt-cache suffix for the whole file.

**Proposal: scaffold the project as modules, not one file.** `main.js` as a
thin bootstrap plus `player.js`, `enemies.js`, `waves.js`, `fx.js`, `hud.js`.
Each is small enough to read whole, edits are local, and cache invalidation is
scoped to one module. This is the highest-value remaining change and it is
mostly scaffolding work, not agent work.

**Expected effect:** most of the remaining 37 views disappear, because a
300-line module does not need a map or a ranged read.

### 2. The engine still has to be the starting point, not an option

Run 2 proved recommendation does not work. The conclusion stands and is
unimplemented: **write the engine into the working tree before the agent's
first turn**, so `main.js` already imports and runs on it and the agent edits a
game that is already engine-backed. Combine with (1) — the scaffold and the
engine are the same piece of work.

Guardrail: measure `usesSkillFns` and `engineImports`, not `skillsImported`. If
the scaffold is deleted or bypassed, that is the signal.

### 3. The agent still cannot see what it built

`juice_score` fell 96 → 91 while the game got twice as large. Nothing in the
loop looks at a frame. `playtest_game` returns numbers — positions, HP, error
counts — and the agent reasons entirely from them.

The browser-worker already screenshots, and the platform's Claude credential is
a vision model. **Feed one frame back and ask what reads as unfinished.** Flat
lighting, untextured primitives, unreadable silhouettes, HUD collisions and
z-fighting are all obvious in a frame and invisible in a state snapshot. This
directly targets "the result isn't impressive", which no amount of state
assertion can reach.

Bound it: one screenshot at the first passing playtest, one after the last
repair. Two vision calls, not a loop.

### 4. Batch tool calls — the audio path already shows the win

Six `generate_audio_asset` calls were emitted in **one turn** (seqs 26–31, all
six results at 32–37). That is one model round trip for six assets. The 272 s
attributed to the last call is the next thinking block, not the tool.

Nothing else batches. Independent `view`s, `find`s and `validate` calls are
issued one per turn, each paying full model latency. **Make batching explicit in
the guidance for every read-only tool**, with the audio pattern as the worked
example.

### 5. `str_replace` failures went 2 → 5

Run 2's improvement did not hold. The file doubled in size, and `patch` with
`expectedOriginal` (production miss rate ~12% vs ~32% for `str_replace`) is
still the minority path: 7 patches against 10 str_replaces.

Cheap fix: once a file passes ~600 lines, have the tool's success message
actively steer toward `patch`, rather than mentioning it in a tip.

### 6. Three agent restarts per run

`agent_start` fired 3 times — chunk boundaries. Each restart re-establishes
context. Worth measuring what a restart actually costs before touching it, but
it is on the list.

---

## Instrumentation to keep

These four queries explain almost any bad run. They are worth keeping to hand:

1. **Wall clock vs AI runtime** from `runs`.
2. **Tool histogram** — `coalesce(event->>'toolName', event->>'type')`.
3. **Latency attribution** — `lead(created_at) OVER (ORDER BY seq) - created_at`
   grouped by tool, filtered to `tool_execution_end`. This is the one that
   matters: it separates *tools being slow* from *the model thinking*, and in
   every run so far it has been overwhelmingly the latter.
4. **View ranges** grouped by count. A sequence like `[160,240] [200,290]
   [240,320] [295,380]` is a linear scan and means the agent cannot find
   something.

## The measurement discipline that produced this

Two of the four changes we shipped from run 1 helped. One made things 48%
worse and was reverted within a day because it was measured, not assumed.

Ship one change at a time against a fixed prompt, and read the trace before
claiming a win.
