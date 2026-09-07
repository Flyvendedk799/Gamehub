/**
 * Derive a live, human-readable build status from the SSE event stream so the
 * builder can show WHAT is happening + HOW FAR ALONG, instead of a generic
 * "Building…" spinner. Pure + deterministic so it's unit-testable.
 *
 * Four monotonic phases (a phase never regresses within a run):
 *   Design → Build → Test → Ready
 * mapped from milestone events: a file write enters Build; a verify tool (or the
 * agent finishing → server-side boot/repair) enters Test; run_complete is Ready.
 */
import { type Activity, collapseSteps, describeActivity } from './build-activity';
import { EDIT_TOOL } from './event-normalize';
import type { BuildStep } from './build-activity';
import type { SseEvent } from './types';

export const BUILD_PHASES = ['Design', 'Build', 'Test', 'Ready'] as const;

const PHASE_HINTS = [
  'Designing your game…',
  'Building your game…',
  'Testing & finishing up…',
  'Your game is ready',
] as const;

/**
 * Tools that mean the agent (or server) is VERIFYING, not authoring. Note
 * `declare_playtest_contract` is deliberately NOT here — the agent declares that
 * up front during design, so counting it would jump the tracker to Test while the
 * game is still being written.
 */
const VERIFY_TOOLS = new Set([
  'validate_game_scene',
  'playtest_game',
  'get_playtest_playbook',
  'assert_game_invariants',
  'runtime_verify',
]);

/**
 * Terminal frames — each one ends a run. The event log is a whole CONVERSATION
 * (every prior run's history is hydrated into it on load), so these are also the
 * boundaries between runs.
 */
const TERMINAL_TYPES = new Set(['run_complete', 'run_error', 'run_paused']);

/**
 * The slice of the log belonging to the run in progress (or, when nothing is
 * running, the most recent one).
 *
 * The builder passes its FULL event log — every earlier run included. Deriving
 * status from all of it made a second prompt show nothing that was happening:
 * an earlier `run_complete` pinned the phase tracker at Ready (100%, every phase
 * ticked) while the new run was still designing, the elapsed timer counted from
 * the project's very first event, and the step list still read as the last
 * build's work. The status appeared frozen, then jumped when the new run's
 * terminal landed.
 */
export function currentRunEvents(events: ReadonlyArray<SseEvent>): ReadonlyArray<SseEvent> {
  let last = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e !== undefined && TERMINAL_TYPES.has(e.type)) {
      last = i;
      break;
    }
  }
  if (last === -1) return events;
  // A trailing terminal ends the LAST run, so that run is the current one — cut
  // at the terminal before it instead (a finished run must still read as Ready).
  if (last === events.length - 1) {
    for (let i = last - 1; i >= 0; i--) {
      const e = events[i];
      if (e !== undefined && TERMINAL_TYPES.has(e.type)) return events.slice(i + 1);
    }
    return events;
  }
  return events.slice(last + 1);
}

export interface BuildStatus {
  /** 0=Design, 1=Build, 2=Test, 3=Ready. */
  phaseIndex: number;
  phase: string;
  /** A short, human-readable description of the current activity. */
  currentStep: string;
  /**
   * The work so far, newest last, consecutive repeats collapsed.
   *
   * A single replaced line hides that anything is progressing — which is how a
   * twenty-six minute build came to look like a hang. The list shows the shape
   * of the work: drew the sprites, wrote the player, played it to check.
   */
  steps: BuildStep[];
  /** Epoch ms of the first event (for the elapsed timer), or null. */
  startedAt: number | null;
  done: boolean;
}

function lastLine(s: string): string {
  const lines = s
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? s.trim();
  return last.length > 110 ? `${last.slice(0, 110)}…` : last;
}

export function deriveBuildStatus(allEvents: ReadonlyArray<SseEvent>): BuildStatus {
  // Only this run's events — an earlier run's terminal would otherwise pin the
  // tracker at Ready and anchor the timer to the project's first-ever event.
  const events = currentRunEvents(allEvents);
  let phaseIndex = 0;
  let step = '';
  let startedAt: number | null = null;
  let lastType = '';
  const activities: Activity[] = [];

  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (startedAt === null && Number.isFinite(t)) startedAt = t;
    lastType = e.type;

    // Phase advance — monotonic (Math.max), driven by milestone events.
    if (e.type === 'run_complete') {
      phaseIndex = 3;
    } else if (e.type === 'agent_end') {
      // Agent done → the server now boots + repairs the game (Test phase).
      phaseIndex = Math.max(phaseIndex, 2);
    } else if (e.type === 'tool_use' && VERIFY_TOOLS.has(e.toolName)) {
      phaseIndex = Math.max(phaseIndex, 2);
    } else if (e.type === 'tool_use' && (e.path !== undefined || e.toolName === EDIT_TOOL)) {
      phaseIndex = Math.max(phaseIndex, 1);
    }

    // Current step — the latest concrete activity (tool label preferred, then the
    // agent's narration sentence). A new user turn resets it to the phase hint.
    if (e.type === 'tool_use' && e.status === 'start') {
      // Prefer the phrasing a person recognises. The raw tool name is a
      // fallback, not the headline — "str_replace_based_edit_tool" told nobody
      // anything.
      // `input` carries the tool arguments; `path` is lifted to the top level
      // by the normaliser, so fall back to it when input is absent.
      const args = e.input ?? (e.path === undefined ? undefined : { path: e.path });
      const activity = describeActivity(e.toolName, args);
      if (activity !== null) {
        activities.push(activity);
        step = activity.label;
      } else if (step.length === 0) {
        step = e.label ?? e.toolName;
      }
    } else if (e.type === 'message_update' && e.content.trim()) {
      step = lastLine(e.content);
    } else if (e.type === 'assistant_text' && e.text.trim()) {
      step = lastLine(e.text);
    } else if (e.type === 'user_message') {
      step = '';
    }
  }

  // No narration yet, or the agent just started/finished a phase boundary → show
  // the phase hint rather than a stale tool label.
  if (!step || lastType === 'agent_end' || lastType === 'agent_start') {
    step = PHASE_HINTS[phaseIndex] ?? PHASE_HINTS[1] ?? 'Building your game…';
  }

  return {
    phaseIndex,
    phase: BUILD_PHASES[phaseIndex] ?? 'Build',
    currentStep: step,
    steps: collapseSteps(activities),
    startedAt,
    done: phaseIndex >= 3,
  };
}

/** Format an elapsed-ms span as `m:ss` (or `h:mm:ss` past an hour). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
