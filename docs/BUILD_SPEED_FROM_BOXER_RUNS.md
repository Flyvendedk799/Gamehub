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

**Status: all six proposals below are implemented.** Each section says what
shipped and what number should move. Nothing here is verified by a production
run yet — that is the next step, and the point of the instrumentation at the
bottom.

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

## What run 3 said to do next

Ordered by measured cost, not by appeal.

### 1. The game is one 1419-line file, written in a single 52 KB `create` — SHIPPED

`src/main.js` was created in **one call carrying 52,334 bytes**, then edited
17 times (10 `str_replace`, 7 `patch`) with 37 views interleaved. Every
consequence of that is expensive:

- The first write is one enormous output burst with no checkpoint.
- Every subsequent edit targets a file too large to hold in working memory, so
  it needs a look first — hence 37 views for 17 mutations, still better than
  2:1.
- A single-byte edit invalidates the prompt-cache suffix for the whole file.

**What shipped:** `PREMIUM_STARTER_FILES` (`packages/core/src/premium-starters.ts`)
seeds a module SET per engine instead of one file — a thin `src/main.js`
bootstrap plus `theme` / `player` / `enemies` / `waves` / `fx` / `hud`, and
`src/scenes/{title,play,over}.js` for Phaser. Every module is under 300 lines and
the entry is under 80. The multi-file prompt guide now opens by telling the agent
it is editing a scaffold, not starting one.

Two things had to be fixed underneath it:

- `buildJsDataUrls` in the game-html exporter never resolved a **sibling**
  import (`'./fx.js'` from `src/main.js`) — it only knew the bundle path and its
  `./`-prefixed form. Every sibling specifier survived inlining as a relative URL
  with no origin, so the module silently never loaded in the verify sandbox or
  the published bundle. Specifiers now resolve against the importing file's
  directory. The same rewrite fixed a latent staleness bug on deep chains
  (`a → b → c` captured a stale `b`), replaced with a depth-first inline.
- `inlineForVerify` skipped canvas2d, so its gate booted an empty page and read
  the injected `window.__game` as a clean boot. canvas2d is inlined now too.

**What should move:** `maxFileLines` and `entryFileLines` (both new in the build
report) stay in the hundreds; views-per-mutation falls from run 3's 2.2 toward 1.

### 2. The engine has to be the starting point, not an option — SHIPPED

Run 2 proved recommendation does not work. **The engine is now written into the
working tree before the agent's first turn**, at `src/engine/core.js`, and
`main.js` already imports and runs on it. It is the same piece of work as (1):
one seeded project, engine included.

Keeping the path under `src/engine/` is deliberate — that is what
`analyzeSkillUsage` counts, so `engineImports` and `usesSkillFns` are non-zero by
construction and a run that deletes or bypasses the scaffold shows up as a drop
rather than as silence.

A per-file guard means a **remix keeps its own game**: if `src/main.js` already
exists, nothing is seeded at all, rather than strewing scaffold modules through a
project that never imports them.

**Guardrail, as stated:** measure `usesSkillFns` and `engineImports`, plus the new
`scaffoldSeeded` / `scaffoldSurvived` / `scaffoldDeleted`. Never `skillsImported`.

### 3. The agent still cannot see what it built — SHIPPED

`juice_score` fell 96 → 91 while the game got twice as large. Nothing in the
loop looked at a frame. `playtest_game` returns numbers — positions, HP, error
counts — and the agent reasoned entirely from them.

**What shipped:** `packages/core/src/visual-critique.ts` (the prompt, the parser,
the repair instruction — pure and tested) plus a `screenshot` port on
`BrowserJobsPort` backed by the existing `thumbnail` job, and a `visionCritic`
port bound in the worker to the run's own model and credential.

Bounded exactly as specified: **two vision calls, not a loop.** One at the first
moment the run would otherwise ship, whose findings buy at most ONE repair round;
one after that repair, recorded and never acted on. It is inert when no vision
critic is wired, and a throwing vision call ships the run unchanged — the whole
layer is advisory and can never fail a build.

The prompt is deliberately narrow ("what reads as unfinished", naming flat
lighting, untextured primitives, unreadable silhouettes, HUD collisions,
z-fighting) because an open-ended critique produces taste notes the agent cannot
act on. The parser fails safe in both directions: unparseable text yields no
findings and no blessing, and concrete findings beat a contradictory `SHIP`.

**What should move:** `visualFindingsAfter < visualFindingsBefore`, and
`juiceScore` stops falling as games grow. If those two do not move together, this
hook has not earned its two calls.

### 4. Batch tool calls — the audio path already shows the win — SHIPPED

Six `generate_audio_asset` calls were emitted in **one turn** (seqs 26–31, all
six results at 32–37). That is one model round trip for six assets. The 272 s
attributed to the last call is the next thinking block, not the tool.

Nothing else batched. **What shipped:** explicit batching guidance in the
text-editor tool description ("BATCH READS… emit them ALL in ONE turn") and in
the game-workflow prompt's cadence section, with the audio pattern as the worked
example, and the reason stated: model latency, not tool time, is where a build
spends its minutes.

**What should move:** tool calls per turn rises; total wall clock falls without
the tool histogram shrinking.

### 5. `str_replace` failures went 2 → 5 — SHIPPED

Run 2's improvement did not hold. The file doubled in size, and `patch` with
`expectedOriginal` (production miss rate ~12% vs ~32% for `str_replace`) was
still the minority path: 7 patches against 10 str_replaces.

**What shipped:** past `LARGE_FILE_PATCH_STEER_LINES` (600), the success message
steers toward `patch` on **every** `str_replace`, not once per file — a tip
mentioned once, hundreds of lines of growth ago, is not steering. The miss path
steers too, where it lands hardest: a failed match on a 900-line file already
prints real line numbers, so the retry can be a patch instead of another guess.
Below the threshold the original one-shot tip is unchanged.

**What should move:** `strReplaceFailures` on large files; the patch:str_replace
ratio inverts.

### 6. Three agent restarts per run — MEASURED

`agent_start` fired 3 times — chunk boundaries. Each restart re-establishes
context. The instruction was to measure what a restart actually costs before
touching it, so that is all that shipped.

**What shipped:** the run-signal aggregator now reports `agentStarts`,
`agentRestarts`, `restartSegmentTurns`, and `restartReestablishTokens` — the
fresh input plus cache **writes** of the first turn of every segment after the
first. That is what re-establishing context actually is: paying again for a
prefix the previous segment had already paid for, with no cache reads to offset
it. `restartReestablishShare` puts it against the run's total billed input.

**Decide from the number, not from the count.** Three restarts costing 2% of
billed input is not a problem; three costing 30% is the largest item on this
list.

---

## Instrumentation to keep

These four queries explain almost any bad run, and they now exist as code rather
than as SQL to be rebuilt from memory:

```bash
pnpm trace:run <run-id>     # or --latest
```

`scripts/trace-run.ts` does the SQL and the formatting;
`packages/core/src/eval/trace-analysis.ts` does the compute (pure, unit-tested):

1. **Wall clock vs AI runtime** from `runs` — a large gap is queue time, a
   different problem that no prompt work will fix.
2. **Tool histogram** — `coalesce(event->>'toolName', event->>'type')`.
3. **Latency attribution** — the gap between a `tool_execution_end` and the next
   event, grouped by tool. This is the one that matters: it separates *tools
   being slow* from *the model thinking*, and in every run so far it has been
   overwhelmingly the latter.
4. **View ranges** grouped by file. A sequence like `[160,240] [200,290]
   [240,320] [295,380]` is a linear scan and means the agent cannot find
   something; three consecutive forward windows flags it.

Plus `viewsPerMutation`, which is §1's argument in one number — run 3 paid 37
views for 17 mutations — and the build-report highlights for §1/§2/§3/§5/§6.

Per-run, the worker also logs one greppable line:

```
[build-speed] scaffold=11/11 engineImports=1 usesSkillFns=7 entryLines=48 maxLines=112 (src/engine/core.js) restarts=0 reestablish=0tok (0.0% of billed input)
```

## The measurement discipline that produced this

Two of the four changes we shipped from run 1 helped. One made things 48%
worse and was reverted within a day because it was measured, not assumed.

Ship one change at a time against a fixed prompt, and read the trace before
claiming a win. Everything above is shipped, not proven — the next fixed-prompt
run against `pnpm trace:run` is what decides which of the six were worth it.
