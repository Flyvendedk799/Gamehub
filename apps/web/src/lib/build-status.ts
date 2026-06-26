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
import { EDIT_TOOL } from './event-normalize';
import type { SseEvent } from './types';

export const BUILD_PHASES = ['Design', 'Build', 'Test', 'Ready'] as const;

const PHASE_HINTS = [
  'Designing your game…',
  'Building your game…',
  'Testing & finishing up…',
  'Your game is ready',
] as const;

/** Tools that mean the agent (or server) is verifying, not authoring. */
const VERIFY_TOOLS = new Set([
  'validate_game_scene',
  'playtest_game',
  'get_playtest_playbook',
  'assert_game_invariants',
  'runtime_verify',
  'declare_playtest_contract',
]);

export interface BuildStatus {
  /** 0=Design, 1=Build, 2=Test, 3=Ready. */
  phaseIndex: number;
  phase: string;
  /** A short, human-readable description of the current activity. */
  currentStep: string;
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

export function deriveBuildStatus(events: ReadonlyArray<SseEvent>): BuildStatus {
  let phaseIndex = 0;
  let step = '';
  let startedAt: number | null = null;
  let lastType = '';

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
      step = e.label ?? e.toolName;
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
