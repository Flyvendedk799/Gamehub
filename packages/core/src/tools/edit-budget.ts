/**
 * Shared per-run counter for the `[edit-budget]` guardrail (game-mode
 * Sequence 3).
 *
 * The 2026-05-03 c44763af trace (and the earlier moj4w21j trace) showed
 * runs where the agent emitted ≥ 18 consecutive `str_replace` calls
 * against the same file region without a `verify_artifact` in between —
 * essentially redoing the same function 8 times because each str_replace
 * left the surrounding context drifted from the model's mental model.
 * This object is the connective tissue between `text_editor` (which
 * increments) and `verify_artifact` (which resets), so the budget is
 * naturally per-region: any successful verify clears the counter for
 * every path because the model has now confirmed the partial artifact
 * still renders, which is the honest "checkpoint" we want to reward.
 *
 * The threshold is intentionally low (5). Most well-formed runs touch
 * 1-3 regions per file before verifying; tripping at 5 catches the
 * thrash class without flagging legitimate work.
 */

const DEFAULT_THRESHOLD = 5;
// Cumulative edits to ONE path across the whole run, regardless of intervening
// verifies. The consecutive counter (above) resets on every verify_artifact, so
// the edit→verify→edit→verify pattern (a real prod run did 132 edits / 24 verifies,
// ~19 edits per file, 34 min) sails past it forever. This counter does NOT reset:
// past ~12 edits to a single file you are thrashing incrementally — each edit is a
// full model round-trip — and should author the file in one block instead.
const DEFAULT_CUMULATIVE_THRESHOLD = 12;

export interface EditBudget {
  /** Returns the warning string when the path has now reached or
   *  exceeded the threshold. Caller appends it to the tool result so
   *  the model SEES the budget hint inside the same response. */
  recordEdit(path: string): string | null;
  /** Resets every path's CONSECUTIVE counter. Called after a successful
   *  `verify_artifact` (or the run-ending `done`). The cumulative
   *  per-path counter is NOT reset — it tracks total incremental churn. */
  reset(): void;
  /** Read-only access for tests / telemetry. */
  countFor(path: string): number;
}

export function createEditBudget(
  threshold: number = DEFAULT_THRESHOLD,
  cumulativeThreshold: number = DEFAULT_CUMULATIVE_THRESHOLD,
): EditBudget {
  const counters = new Map<string, number>();
  const cumulative = new Map<string, number>();
  const cumulativeWarned = new Set<string>();
  return {
    recordEdit(path) {
      const next = (counters.get(path) ?? 0) + 1;
      counters.set(path, next);
      const cum = (cumulative.get(path) ?? 0) + 1;
      cumulative.set(path, cum);
      // Cumulative warning fires ONCE per path and survives verifies — it catches
      // the incremental-edit pattern that resets the consecutive counter by
      // verifying between edits. Takes priority (it's the bigger inefficiency).
      if (cum >= cumulativeThreshold && !cumulativeWarned.has(path)) {
        cumulativeWarned.add(path);
        return formatCumulativeWarning(path, cum, cumulativeThreshold);
      }
      if (next < threshold) return null;
      return formatWarning(path, next, threshold);
    },
    reset() {
      counters.clear();
    },
    countFor(path) {
      return counters.get(path) ?? 0;
    },
  };
}

function formatWarning(path: string, count: number, threshold: number): string {
  return `\n\n[edit-budget] ${count} consecutive str_replace calls against ${path} without an intervening verify_artifact (threshold ${threshold}). STOP and rewrite the entire region with a single str_replace whose old_str is a unique comment anchor (e.g. \`// ── WAVE SYSTEM ─\`) bounding the whole block. See game-workflow.v1.txt §"Edit budget".`;
}

function formatCumulativeWarning(path: string, count: number, threshold: number): string {
  return `\n\n[edit-budget] You have made ${count} separate edits to ${path} across this run (threshold ${threshold}) — that is incremental thrash: EVERY edit is a full model round-trip that re-reads the whole context, so a piecemeal file is the #1 cause of a slow, expensive build. STOP editing it piecemeal. Compose the file's COMPLETE final content and write it in ONE \`create\` call, then move on. Verifying does not reset this — only authoring in blocks does.`;
}
