# Provider parity: prepared, not measured

`evals/provider-parity/plan.json` contains 126 randomized cases: 14 briefs × Codex, Claude, Gemini/Antigravity × three independent repetitions. Preparation made **zero model calls**. The existing `pnpm eval:games` command replays historical recordings; it is not this benchmark and must not be reported as fresh parity evidence.

## Before your run

1. Finish the deployment checklist in `docs/ISOLATED_GAME_DEPLOYMENT.md`. Test a preview and publish on the deployed domains before using paid generations.
2. Record the tested Git commit and fill each path's exact model ID, reasoning setting, endpoint label, per-run token ceiling and total spending ceiling in the plan. Never put credentials in the plan or result files. Use the same budgets across paths for the first comparison. Keep the platform's token/credit limits enabled.
3. In account settings, select the path and exact model specified by each case. Start a fresh project for each initial generation. Follow the randomized order in the plan; do not reuse projects or silently substitute providers.
4. Stop at the spending ceiling. Include failed, interrupted and unavailable runs in the results. Do not replace failures with a retry that hides the original attempt.

## For each case

Paste the case's `brief`, then record the run ID, exact model ID, endpoint label, commit, immutable snapshot/hash, elapsed time, tokens, actual billed spend (or `null` if unknown), repair count and failure cause. Save evidence under the case's `evidenceFile` path, using the template below. Never infer zero spend from missing pricing metadata.

Play with the intended input on desktop and a touch-sized viewport. Capture the title, active play, and a failure or win followed by restart. Confirm sound is **audible after a user gesture**; an audio tool call or oscillator construction does not prove that. Check legible objectives, controls, feedback and that the core mechanic matches the brief.

Apply the fixed `edit` prompt, repeat the original gameplay checks and check pause/resume. Follow the `recovery` instruction and confirm the previous verified game remains playable. Publish the edited version only after verification passes. Record the published hash and independently open its play URL. If verification is unavailable, record that result; do not bypass the gate.

Hide provider/model names when asking reviewers to score fidelity, readability, game feel, originality and willingness to replay, each from 1–5. Include written reasons. Review screenshots for appearance and actual play for game feel. A screenshot alone cannot establish gameplay quality.

```json
{
  "schemaVersion": 1,
  "caseId": "copy from plan",
  "status": "not_run",
  "exactModelId": null,
  "commit": null,
  "runId": null,
  "artifactHash": null,
  "boot": null,
  "inputBehavior": null,
  "editRegression": null,
  "restore": null,
  "publicationVerified": null,
  "publishedArtifactHash": null,
  "screenshots": { "title": null, "play": null, "failureOrWin": null },
  "audioAudible": null,
  "elapsedMs": null,
  "costUsd": null,
  "tokens": null,
  "repairCount": null,
  "failureCause": null,
  "blindReview": { "fidelity": null, "readability": null, "feel": null, "originality": null, "replay": null }
}
```

## Interpret results

Report completion, boot/input success, preserved edit behavior and publish success **separately for each path**, with all attempted cases in the denominator and missing evidence explicitly counted. Report p50/p90 elapsed time, actual spend per accepted game, and unknown spend separately. Compare blind review scores by brief; do not average away a broken core mechanic. Report confidence intervals on rates, and treat three repetitions per brief as diagnostic rather than proof of equivalence. No path is certified by the prepared plan or by local adapter tests.

To prepare another independent plan without overwriting results:

```sh
pnpm benchmark:prepare evals/provider-parity/next-plan.json
```

The preparation command refuses to overwrite an existing file. It does not run the cases or charge any provider.
