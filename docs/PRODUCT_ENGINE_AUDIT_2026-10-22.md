# PlayerZero product and engine audit

Audit date: 2026-10-22. Repository baseline: `b686b8b`.

## Judgment

The architecture is capable of becoming a strong “Lovable for games.” The main gap is the contract between what the user asked for, what the engine actually verified, and what the product tells the user is ready. More prompts, tools, or UI panels alone will not close it.

Keep the shared engine. Make provider differences explicit at its boundary, require evidence for readiness, and make creative direction a persistent part of the game rather than an optional instruction. Prioritize the create → play → change → share journey before expanding adjacent features.

“Equally good” should mean the same supported capabilities, safety boundaries, verification requirements, and user experience across providers. It cannot mean identical output or identical speed from different models. Certify each provider/model/transport combination against the same outcome benchmark.

## Scope and evidence limits

Reviewed the current worker/agent/provider path, starters and prompts, playtest and visual critique, finalization and publication, frontend build feedback, onboarding/interview, origin boundaries, tests, and previous audit documents. Rendered and visually inspected the local logged-out home page. Builder findings are based on source, not an authenticated live walkthrough.

Ran repository checks and the offline evaluation harness. No paid model generations, production telemetry queries, deployments, or production penetration tests were performed. Thus this report establishes code-level defects and measurement gaps; it does **not** establish which provider currently produces the best games or a measured originality score. The plan referenced by AGENTS.md was unavailable at its stated local path.

Older documents are historical evidence, not the current baseline. Audio instrumentation, content-plan checks, premium starters, skill imports, real browser-worker tests, reconnect handling, transactional finalization, engine persistence, and immutable remix snapshots now exist. Do not reopen their old “missing implementation” tickets wholesale.

## Confirmed findings, ordered by consequence

### A1 — Preview isolation contradicts the configured deployment (P0)

`apps/web/src/components/PreviewPane.tsx:541` permits both scripts and same-origin behavior, justified by a comment that the API is a different origin. However, `apps/web/next.config.mjs` proxies `/v1/*` through the app, and `deploy/docker-compose.yml:183` sets the browser API URL to the app domain. `apps/web/src/lib/auth.ts` stores the session token in localStorage. Preview CSP permits same-origin connections and has no sandbox directive that restores origin separation.

Under this configured topology, untrusted generated JavaScript is given the app origin, contradicting the non-negotiable project boundary. The risk includes access to same-origin application state/session credentials. This is a source-confirmed configuration combination, not a demonstrated production exploit.

**Action:** serve previews and published games on isolated per-project game origins, with app credentials never sent there. Use narrowly scoped preview authorization and validate message source plus origin. Add an adversarial integration test through the actual reverse-proxy topology that proves a game cannot read parent DOM, app storage/cookies, or authenticated API responses. Treat this as a release blocker.

### A2 — Completion is not a quality verdict (P1)

`packages/core/src/repair-loop.ts` explicitly returns `ship` for `no_verdict`, `budget_exhausted`, and `repair_exhausted`. `packages/core/src/tools/done.ts:1202` can turn a still-failing verification into `status: 'ok'` after its bounded attempts. The worker does add independent AST/runtime checks, so this is not a claim that every failure bypasses all checks. Nevertheless, failed playtest outcomes can reach normal finalization.

`services/worker/src/finalize-run.ts:193` records a completed run and advances project HEAD; `services/worker/src/queue.ts:309` emits a bare `run_complete`. `apps/web/src/lib/build-status.ts` maps that to Ready. These layers do not carry one authoritative readiness decision to the user.

**Action:** separate execution status from artifact quality. Persist a versioned assessment tied to the exact snapshot hash: `verified`, `needs_fixes`, or `unverified`, with evidence and limitations. Keep failed attempts as recoverable drafts; preserve a last-known-playable version. Bounded repair must stop spending, not redefine failure as success. Only show “Ready to play” when the required checks pass; otherwise show what works, what failed, and a concrete recovery action.

### A3 — Publication verification fails open (P1)

`services/api/src/server.ts:3003` runs live smoke verification only when `browserQueue` exists. A missing result produces no rejection; exceptions are logged and publishing continues. At the end the row is explicitly marked live. Publication does have a useful static engine/contract check and rejects observed boot failures, but unavailable evidence is treated differently from an observed failure. It also does not require the generation's behavioral verdict.

The candidate bundle is upserted before the live smoke gate, so verification should also be separated from promotion of the publicly served version.

**Action:** verify the exact exported candidate, retain the previous public version, then atomically promote the candidate. Missing verification should leave `verification_pending` with retry, not a live success. Validate both boot and the minimum behavior contract; do not mistake asset packaging success for playable success.

### A4 — Shared loop, inconsistent capability and configuration handling (P1)

All three routes can reach `generateViaAgent`, which is the right foundation. The differences are in its adapters and auxiliary calls:

| Area | Current evidence | Consequence |
|---|---|---|
| Model metadata | `packages/core/src/agent.ts:515` builds models with `reasoning: true`, text-only input, 400,000 context, 196,608 max output, and zero cost defaults. `packages/providers/src/index.ts:274` synthesizes auxiliary models differently. | One model has different assumed capabilities depending on which call path is used. These are not verified limits for every model. |
| Tool/reasoning policy | `agent.ts:1835` varies Anthropic thinking with forced tools. The Antigravity branch always forces tools and does not forward the calculated reasoning value, although its adapter supports reasoning. | The same selected setting does not imply the same applied behavior. |
| Visual critique routing | `services/worker/src/main.ts:390` passes model, wire and headers to `complete`, but omits the run's custom base URL and uses the captured key. Critique errors are non-fatal in `run-generation.ts`. | Custom endpoint and long-running credential cases can silently lose the visual review stage. |
| Generated art | `services/worker/src/asset-generator.ts:29` requires an OpenAI Images credential, directly or via platform fallback. | Art capability depends on deployment configuration, not just the user's selected text model. |
| Outcome parity | `agent-parity.test.ts` compares legacy and agent paths using mocked HTML, not three providers generating games. `agent.live.test.ts` is an opt-in Anthropic test. | Compatibility tests do not establish game-quality parity. |

**Action:** introduce one resolved model/capability profile shared by planning, generation, critique, repair and summarization: provider, model, transport, endpoint, refreshing credential getter, input types, context/output limits, reasoning mapping and supported tool policy. Keep platform asset generation independent of text provider. Record the resolved profile and capability availability per run. Use adapter-specific protocol handling without changing product requirements.

Do not hide unsupported capability behind success. If vision or asset generation is unavailable, expose that to orchestration and either use a configured compatible service or mark the corresponding assessment unavailable.

### A5 — The evaluation harness cannot establish current generation quality (P1)

`pnpm eval:games --no-write` reports **6/14 passing**, with eight missing recordings: ambient-garden, fishing, fps-arena, kitchen, rhythm, tower-defense, visual-novel, wordfall.

The runner (`packages/core/scripts/eval-games.ts`) replays saved observations. It does not generate new games or execute current code in those recorded games. Existing recordings do not constitute a matched multi-provider trial. `packages/core/src/eval/runner.ts:131` still grades required audio from tool-call counts, despite runtime audio counters now existing elsewhere.

**Action:** retain replay tests for scorer correctness, and add fresh end-to-end benchmark runs tagged with commit, prompt version, model/profile, artifact hash, evidence, wall time and spend. Measure what players observe: input response, restart, objective/loop, audible event feedback, visual readability, brief fidelity and regression after edits. A generated audio asset is not proof it played; shader motion is not proof of fun.

### A6 — Active instructions fight the seeded architecture (P1)

`packages/core/src/premium-starters.ts` deliberately seeds small modules to reduce edit cost. Its documentation describes a thin bootstrap with separate player, enemies, waves, effects, HUD and theme modules. Yet the active inlined prompt at `packages/core/src/prompts/index.ts:1147` says to keep a single-mechanic game in ONE `src/main.js`, putting scenes/helpers/feel inline. Step 6 describes `main.js` as the complete premium starter. The standalone workflow text repeats this.

These conflicting directives can cause an otherwise compliant model to flatten or misunderstand the scaffold. Which instruction wins may differ between models. Separately, the runtime supports Canvas2D while AGENTS.md still says Phaser/Three only; public branding is PlayerZero while the namespace and top-level docs remain Playforge.

**Action:** reconcile the architecture and scope first. Generate prompt representations from one canonical source; add a contract test that starter files and authoring instructions agree. Preserve existing modules during edits, while allowing intentional alternatives for ideas that need them. Update AGENTS/README to the chosen scope instead of enforcing stale constraints through different layers.

### A7 — Originality has guidance but no independently assessed outcome (P1)

The code has capability-based specs, content plans and anti-slop rules. These are valuable. However, the premium starters begin with a dodge-the-falling-things game and a repeated palette. The visual critic (`packages/core/src/visual-critique.ts:75`) explicitly excludes game design, difficulty and whether the idea is good. It inspects one frame, with one optional repair; the second critique is recorded but not acted on.

This does not prove that every output is generic. It does mean that a polished reskin can satisfy much of the available evidence without demonstrating a distinctive mechanic or sustained player interest.

**Action:** persist a concise creative brief: intended player experience, defining interaction, meaningful decision, visual language, pacing and things to preserve. Select or compose starter systems around that brief; keep infrastructure reusable while avoiding a fixed game premise. Validate that the defining interaction exists in play, not just in `GameSpec`. Add blind human review of brief fidelity, readability, feel, meaningful decisions and “would I play again?” Include ambient/narrative games without forcing combat, failure or escalation onto them.

For originality, compare multiple outputs from unrelated briefs and multiple outputs from the same brief. Check for repeated mechanics, layouts, palettes and progression patterns; similarity is a review signal, not an automatic creativity score.

### A8 — Build feedback has competing, heuristic state models (P1)

`apps/web/src/lib/build-status.ts` isolates the current run and uses monotonic milestones. `generation-inspector-data.ts` independently iterates the full event list, guesses phase from substrings of tool names, increments repair count when names contain patch/repair/reflexion, hardcodes two repair turns, and does not explicitly model pause. Its initial non-building state is completed. A normal patch can therefore look like repair, and historical events can contaminate the current view until new evidence arrives.

The global builder banner and preview can both show the newer stepper. The UI exposes “Reflexion Turn,” “Pruning Imminent,” and token/context concepts that do not help most creators decide what to do next.

**Action:** emit typed server events with run/attempt identity and explicit phase/outcome. Use one reducer for chat, stepper, preview and reload hydration. Put internals in optional diagnostics. Default feedback should say: “Building the movement,” “Testing your controls,” “Fixing the restart button,” or “Saved a draft; controls still need work.” Show estimates only once measured; show elapsed time and next milestone meanwhile.

### A9 — Interview lifecycle can strand the user; chat forces scrolling (P2)

`DesignInterview.tsx:66` sets a `startedRef` guard, then cleanup marks its request canceled. React Strict Mode's setup/cleanup/setup sequence leaves the second setup skipped and the first result ignored. `next.config.mjs` enables Strict Mode. This is a source-level deterministic development lifecycle bug; ordinary production mounting is not claimed to fail the same way. A prompt change on the same instance has a similar lifecycle problem. The waiting screen offers Back but no “Build now” escape, and the request has no local deadline in `fetchInterviewPlan`.

`ChatPanel.tsx:42` scrolls to the bottom on every event, even if the user is reading earlier feedback.

**Action:** use cancellation-safe request ownership/cache, a timeout and build-now fallback; test Strict Mode and changed prompts. Follow the chat tail only while the user is already near it, otherwise show a “new updates” affordance. Test these as user behaviors rather than static markup.

### A10 — The entry experience still resembles a technical console (P2)

Observed on the rendered local home page: strong typography and a consistent dark/cyan identity, but text-only genre examples, low-emphasis helper text, prominent Phaser/Three/Canvas choices, a Mac shortcut hint on this Windows machine, and “PHASE 0 · DEV BUILD” copy. The promise says playable “instantly”; the repository's own historical run investigations describe multi-minute generation.

**Action:** make the first decision about the idea. Default to automatic engine selection; put advanced choices behind a disclosure, or offer understandable 2D/3D intent. Replace generic genre examples with playable previews showing different interactions and art directions. Show the proposed game and its distinctive hook before the long build. After generation, foreground Play, controls, what changed, and the next useful edit. Keep version recovery easy. Validate contrast, keyboard navigation and mobile touch behavior with rendered measurements, not assumptions from class names.

## Recommended target design

Use one product pipeline with explicit artifacts:

`idea → creative brief → capability plan → playable draft → behavioral/visual assessment → bounded repair → versioned result → verified publish candidate`

The model adapter supplies normalized messages, tools and usage. It does not decide whether a game is ready. The orchestrator owns phase transitions, budget reservation, checkpoints and assessment requirements. Runtime and browser workers supply independent evidence. The UI renders those decisions instead of guessing them from model output.

Save a versioned quality report per immutable artifact containing required checks, observed results, missing evidence, tested devices/inputs, unresolved issues and model/profile provenance. Distinguish generation completion, behavioral verification, visual review, and human preference. Keep creative scoring advisory until calibrated against real players; keep boot/input/isolation requirements deterministic.

## Delivery sequence and acceptance criteria

These are ordered work packages, not a promise of elapsed delivery time.

| Sequence | Work package | Exit criteria |
|---|---|---|
| 1 | Restore trust: isolation, truthful completion, staged publish | Same-origin adversarial tests pass through deployment routing; unavailable/failed verification never yields Ready/live; failed edits retain playable predecessor. |
| 2 | Repair baseline and instruction conflicts | Typecheck/lint/test suite green; canonical prompts match starter structure; declared engine/brand scope documented. |
| 3 | Resolve provider profiles and auxiliary routing | Codex, Claude and Gemini/Antigravity adapter contracts pass for tool rounds, reasoning, images, refreshed credentials, cancellation and continuation; critique receives the same resolved endpoint/profile. |
| 4 | Establish a fresh outcome baseline | All 14 briefs run on each supported path with complete evidence; budget, latency and failure causes reported separately by path. Include an edit and recovery scenario. |
| 5 | Simplify creator feedback | One run-state reducer; meaningful progress and honest terminal states; interview escape, reconnect/resume, preserved chat scroll and last-good preview verified by browser journeys. |
| 6 | Raise distinctiveness and game feel | Persistent creative brief; composable starter selection; multi-moment play evidence; blind human comparison shows improvement in fidelity, feel and willingness to replay. |

Start the benchmark with **14 briefs × 3 paths × 3 independent generations = 126 generations**, plus a fixed edit on each if budget permits. This is a proposed experiment, not work already performed. Use a declared spend cap, randomized order, exact model IDs and separate equal-budget versus equal-quality comparisons. A small three-repeat batch is diagnostic, not enough to make strong statistical parity claims.

Proposed launch targets, to calibrate after the baseline:

- 100% of public promotions have fresh passing isolation/boot/input evidence tied to the published artifact.
- At least 95% playable completion on the supported benchmark per certified path, with confidence intervals and enough subsequent samples to support the claim.
- At least 90% of fixed follow-up edits preserve previously passing behavior.
- Zero UI claims of verified success when evidence is failed or unavailable.
- Blind human median at least 4/5 on brief fidelity and readability; track feel and originality separately, without letting a high art score hide broken controls.
- Track p50/p90 time to first playable, time to verified completion, spend per accepted game, retries and user corrections. Set concrete latency/spend targets after measuring current runs.

Provider certification should be per capability and engine, not one global “supports Gemini” checkbox. A path that fails a benchmark should remain experimental for that scope until corrected; automatic fallback must disclose a material model/cost change and respect the user's configuration.

## Verification performed

- `pnpm eval:games --no-write`: failed, 6/14 recorded fixtures pass; eight recordings missing. This measures saved evidence, not fresh generations.
- `pnpm typecheck`: 14/15 workspace tasks succeeded; web failed at `src/app/party/create/page.tsx:13` with TS2786 (`Link` cannot be used as a JSX component).
- `pnpm lint`: failed, 368 Biome errors across 768 checked files. Includes formatting/configuration debt; not 368 demonstrated runtime bugs.
- Initial `pnpm test`: blocked by missing local Playwright Chromium. Installed the project's requested Chromium via its existing Playwright CLI, then ran `pnpm exec turbo run test --continue=always` to collect all package outcomes.
- Full test run: 14/15 workspace tasks succeeded. Core: 1,462 passed, one opt-in live test skipped. Providers: 293 passed. Worker: 207 passed. Browser worker: 36 passed. API: 303 passed. Web: 319 passed, two failed.
- Targeted web rerun: the jam storage timeout passed; the token-gauge assertion still failed because it expects `165,000` while this locale renders `165.000`. Treat the first as a timing/flakiness observation and the second as a reproducible locale-sensitive test.
- Local home page rendered successfully in the browser. No authenticated builder, live generated game quality, public deployment or mobile usability claim is inferred from that single view.

At the time of this audit, only this document was changed. Subsequent implementation and its validation limits are recorded in [the implementation follow-up](AUDIT_IMPLEMENTATION_2026-10-23.md).
