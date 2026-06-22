/**
 * Per-run signal aggregator — distils the agent's live AgentEvent stream into a
 * compact, queryable picture of HOW a game was built, so we can learn from runs
 * (which tools/skills the agent reached for, what the quality gate flagged,
 * whether it took the genre-less contract path). Fed from run-generation's
 * wrapped event sink alongside token metering; emitted as a `[build-report]`
 * JSON log line and persisted to run_quality_metrics.report.
 *
 * Pure + side-effect-free so it is unit-testable without a live agent.
 */
import type { AgentEvent } from '@playforge/agent-core';

export interface RunSignal {
  /** Histogram of tool name -> call count across the whole run. */
  toolCalls: Record<string, number>;
  /** Total tool calls (sum of the histogram). */
  toolCallTotal: number;
  /** Skills the agent actually opened via view_game_feel (e.g. phaser/wave-spawner.js). */
  skillsViewed: string[];
  /** Skills the agent wrote to disk via import_skill (v3 P1). Distinct from
   *  skillsViewed — post-v2 the agent IMPORTS skills rather than viewing them, so
   *  adoption metrics must union both or they under-report (recommendedButUnused
   *  was blind to import_skill entirely). */
  skillsImported: string[];
  /** Invariant ids the FINAL assert_game_invariants pass flagged (e.g. escalation). */
  invariantWarnings: string[];
  /** True when the agent committed a declare_playtest_contract — the genre-less /
   *  novel-idea path. A key "did this fit a box or not" signal. */
  contractAuthored: boolean;
  /** True when the run declared a tweak schema (live-tweakable params). */
  tweakSchemaDeclared: boolean;
  /** Count of str_replace tool results that reported a failure (edit thrash). */
  strReplaceFailures: number;
}

function toolNameOf(event: AgentEvent): string | undefined {
  const name = (event as { toolName?: unknown }).toolName;
  return typeof name === 'string' ? name : undefined;
}

/** Stateful aggregator. Call `observe(event)` for every AgentEvent, then
 *  `snapshot()` once the run settles. */
export function createRunSignalAggregator() {
  const toolCalls: Record<string, number> = {};
  const skills = new Set<string>();
  const imported = new Set<string>();
  let invariantWarnings: string[] = [];
  let contractAuthored = false;
  let tweakSchemaDeclared = false;
  let strReplaceFailures = 0;

  return {
    observe(event: AgentEvent): void {
      if (event.type === 'tool_execution_start') {
        const name = toolNameOf(event);
        if (!name) return;
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        if (name === 'declare_playtest_contract') contractAuthored = true;
        if (name === 'declare_tweak_schema') tweakSchemaDeclared = true;
        if (name === 'view_game_feel' || name === 'import_skill') {
          // import_skill capture is finalised on tool_execution_end (details.name
          // is guaranteed); this start-event arg is a best-effort fallback.
          const args = (event as { args?: { name?: unknown } }).args;
          if (args && typeof args.name === 'string') {
            (name === 'import_skill' ? imported : skills).add(args.name);
          }
        }
        return;
      }
      if (event.type === 'tool_execution_end') {
        const name = toolNameOf(event);
        if (!name) return;
        const result = (event as { result?: { details?: unknown } }).result;
        const details = result?.details as
          | { issues?: Array<{ invariant?: unknown }>; ok?: boolean; name?: unknown }
          | undefined;
        if (name === 'import_skill' && details && typeof details.name === 'string') {
          // PRIMARY capture (ImportSkillDetails.name is always populated).
          imported.add(details.name);
        }
        if (name === 'assert_game_invariants' && details && Array.isArray(details.issues)) {
          // Keep the LAST pass — that's the state the run shipped with.
          invariantWarnings = details.issues
            .map((i) => (typeof i.invariant === 'string' ? i.invariant : null))
            .filter((v): v is string => v !== null);
        }
        // The agent's edit tool is `str_replace_based_edit_tool` (str_replace /
        // patch / create commands). The earlier 'str_replace'/'text_editor' names
        // never matched a real event, and isError is TOP-LEVEL on the event, not
        // on result — so this counter was always 0. Match the real name + read the
        // right field (with the legacy names + result.isError kept as fallbacks).
        if (
          name === 'str_replace_based_edit_tool' ||
          name === 'str_replace' ||
          name === 'text_editor'
        ) {
          const ev = event as { isError?: boolean; result?: { isError?: boolean } };
          if (ev.isError === true || ev.result?.isError === true) strReplaceFailures += 1;
        }
      }
    },
    snapshot(): RunSignal {
      const toolCallTotal = Object.values(toolCalls).reduce((a, b) => a + b, 0);
      return {
        toolCalls: { ...toolCalls },
        toolCallTotal,
        skillsViewed: [...skills].sort(),
        skillsImported: [...imported].sort(),
        invariantWarnings: [...invariantWarnings],
        contractAuthored,
        tweakSchemaDeclared,
        strReplaceFailures,
      };
    },
  };
}
