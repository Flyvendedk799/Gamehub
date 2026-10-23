/**
 * The chat as a conversation, not a log.
 *
 * The event stream is every frame a run emits: tool starts and ends, narration deltas, agent
 * start/end markers, plans, spec cards, terminal frames. Rendered one-per-row that reads as a build
 * log, which is accurate and exhausting. A person asked for something; what they want to see is an
 * agent that goes and does it, shows what it is on right now, and then reports back.
 *
 * This module folds the stream into turns:
 *
 *   - a USER turn: what they asked for
 *   - an AGENT turn: the steps it took (live while working, collapsed once done), its closing
 *     summary, the files it changed, whether the preview already shows the result, and how it ended
 *
 * Everything here is pure so the folding rules are unit-tested; the components only draw turns.
 */

import type { GameQuality } from '@playforge/shared/game-quality';
import { describeActivity } from './build-activity';
import { writtenPaths } from './event-normalize';
import type { ProgressPhase, SseEvent } from './types';

export type StepState = 'active' | 'done' | 'failed';

export interface TurnStep {
  label: string;
  state: StepState;
  /** Consecutive repeats of the same step, folded into one row. */
  count: number;
  phase?: ProgressPhase;
}

export type AgentStatus = 'working' | 'done' | 'error' | 'paused';

export interface UserTurn {
  kind: 'user';
  key: string;
  text: string;
}

export interface AgentTurn {
  kind: 'agent';
  key: string;
  runId: string;
  status: AgentStatus;
  steps: TurnStep[];
  /** The agent's own running commentary, for the "details" view; never the headline. */
  notes: string[];
  /** Its closing account, shown as the reply. Null while working or when it said nothing. */
  summary: string | null;
  files: string[];
  startedAt: number | null;
  endedAt: number | null;
  /** The new version is already showing in the preview (it booted cleanly). */
  previewUpdated: boolean;
  spec: { genre?: string; winCondition?: string; loseCondition?: string } | null;
  plan: Array<{ text: string; checked: boolean }> | null;
  quality: GameQuality | null;
  error: string | null;
  /** Set when the agent paused to ask the player something. */
  question: string | null;
}

export type ChatTurn = UserTurn | AgentTurn;

export interface BuildTurnsOptions {
  /** Whether a run is streaming right now. An unfinished turn reads as working only then. */
  streaming: boolean;
}

const PHASE_OF_KIND: Record<string, ProgressPhase> = {
  design: 'understand',
  assets: 'edit',
  audio: 'edit',
  code: 'edit',
  polish: 'edit',
  test: 'test',
};

function timeOf(event: SseEvent): number | null {
  const t = Date.parse((event as { timestamp?: string }).timestamp ?? '');
  return Number.isFinite(t) ? t : null;
}

function newAgentTurn(key: string, runId: string): AgentTurn {
  return {
    kind: 'agent',
    key,
    runId,
    status: 'working',
    steps: [],
    notes: [],
    summary: null,
    files: [],
    startedAt: null,
    endedAt: null,
    previewUpdated: false,
    spec: null,
    plan: null,
    quality: null,
    error: null,
    question: null,
  };
}

/** Add a step: the previous one is finished, and a repeat of the same label folds into it. */
function pushStep(turn: AgentTurn, label: string, phase?: ProgressPhase): void {
  const last = turn.steps[turn.steps.length - 1];
  if (last !== undefined && last.label === label) {
    last.count += 1;
    last.state = 'active';
    return;
  }
  if (last !== undefined && last.state === 'active') last.state = 'done';
  turn.steps.push({ label, state: 'active', count: 1, ...(phase !== undefined ? { phase } : {}) });
}

/** Mark the turn's steps as finished the way the turn itself finished. */
function settleSteps(turn: AgentTurn, ending: 'done' | 'failed'): void {
  for (const step of turn.steps) {
    if (step.state === 'active') step.state = ending;
  }
}

/** Events that belong to an agent turn (as opposed to a user message). */
const AGENT_EVENT_TYPES = new Set<string>([
  'agent_start',
  'agent_end',
  'progress',
  'summary',
  'draft_ready',
  'tool_use',
  'tool_result',
  'text_delta',
  'assistant_text',
  'message_update',
  'thinking_delta',
  'game_spec',
  'plan',
  'run_complete',
  'run_error',
  'run_paused',
]);

export function buildTurns(
  events: readonly SseEvent[],
  options: BuildTurnsOptions = { streaming: false },
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let open: AgentTurn | null = null;
  let narration = '';
  let counter = 0;
  // When the player asked: the agent's clock starts there, not at its first event.
  let askedAt: number | null = null;

  const flushNarration = (): void => {
    const text = narration.trim();
    narration = '';
    if (text.length > 0 && open !== null) open.notes.push(text);
  };

  /** Close the open turn: anything still in progress is finished. */
  const close = (endedAt: number | null): void => {
    if (open === null) return;
    flushNarration();
    if (open.status === 'working') open.status = 'done';
    settleSteps(open, open.status === 'error' ? 'failed' : 'done');
    if (open.endedAt === null) open.endedAt = endedAt;
    open = null;
  };

  /** Files written by the events of one turn, in order and without repeats. */
  const turnEvents = new Map<AgentTurn, SseEvent[]>();
  /** Files a run reported with its summary (the host's own edits write no tool events). */
  const reportedFiles = new Map<AgentTurn, readonly string[]>();

  for (const event of events) {
    if (event.type === 'user_message') {
      close(timeOf(event));
      askedAt = timeOf(event);
      turns.push({ kind: 'user', key: `user-${counter++}`, text: event.content });
      continue;
    }
    if (!AGENT_EVENT_TYPES.has(event.type)) continue;

    if (open === null) {
      open = newAgentTurn(`agent-${counter++}`, (event as { runId?: string }).runId ?? '');
      turnEvents.set(open, []);
      open.startedAt = askedAt;
      askedAt = null;
      turns.push(open);
    }
    const turn: AgentTurn = open;
    turnEvents.get(turn)?.push(event);
    const at = timeOf(event);
    if (turn.startedAt === null && at !== null) turn.startedAt = at;
    if (turn.runId === '' && (event as { runId?: string }).runId) {
      turn.runId = (event as { runId: string }).runId;
    }

    switch (event.type) {
      case 'progress':
        flushNarration();
        pushStep(turn, event.label, event.phase);
        break;

      case 'tool_use': {
        if (event.status !== 'start') break;
        const activity = describeActivity(event.toolName, event.input);
        if (activity === null) break;
        flushNarration();
        pushStep(turn, activity.label, PHASE_OF_KIND[activity.kind]);
        break;
      }

      case 'text_delta':
        narration += event.delta;
        break;
      case 'assistant_text':
        narration = event.text;
        break;
      case 'message_update':
        flushNarration();
        narration = event.content;
        flushNarration();
        break;

      case 'game_spec':
        turn.spec = {
          ...(event.genre ? { genre: event.genre } : {}),
          ...(event.winCondition ? { winCondition: event.winCondition } : {}),
          ...(event.loseCondition ? { loseCondition: event.loseCondition } : {}),
        };
        break;

      case 'plan':
        turn.plan = event.items.map((item) => ({ text: item.text, checked: item.checked }));
        break;

      case 'draft_ready':
        turn.previewUpdated = true;
        break;

      case 'summary':
        turn.summary = event.text;
        if (event.files !== undefined) reportedFiles.set(turn, event.files);
        break;

      case 'run_complete':
        flushNarration();
        turn.status = 'done';
        turn.quality = event.quality ?? null;
        turn.endedAt = at;
        close(at);
        break;

      case 'run_error':
        flushNarration();
        turn.status = 'error';
        turn.error = event.error;
        turn.endedAt = at;
        close(at);
        break;

      case 'run_paused':
        flushNarration();
        turn.status = 'paused';
        turn.question = event.question ?? null;
        turn.endedAt = at;
        close(at);
        break;

      default:
        break;
    }
  }

  // A turn with no terminal yet is still being worked on, but only while a run is streaming; once
  // the stream has ended an unterminated turn is simply over.
  const last = open as AgentTurn | null;
  if (last !== null) {
    flushNarration();
    if (!options.streaming) {
      last.status = 'done';
      settleSteps(last, 'done');
    }
  }

  for (const [turn, evs] of turnEvents) {
    const fromTools = writtenPaths(evs);
    const reported = reportedFiles.get(turn) ?? [];
    turn.files = [...new Set([...fromTools, ...reported])];
  }
  return turns;
}

/** The step the agent is on, for a headline; a calm default before the first one arrives. */
export function currentLabel(turn: AgentTurn): string {
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const step = turn.steps[i];
    if (step !== undefined && step.state === 'active') return step.label;
  }
  return turn.steps[turn.steps.length - 1]?.label ?? 'Getting started';
}

/** "Worked for 2m 48s", "Worked for 45s"; null when the turn has no usable timestamps. */
export function workedFor(turn: AgentTurn): string | null {
  if (turn.startedAt === null || turn.endedAt === null) return null;
  const seconds = Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000));
  if (seconds < 1) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** True when a version shipped but one of the automated checks did not pass. */
export function hasOpenIssues(turn: AgentTurn): boolean {
  return (
    turn.quality !== null && turn.quality.status !== 'verified' && turn.quality.issues.length > 0
  );
}

/** The request that asks the agent to fix what the checks flagged. */
export function fixIssuesPrompt(issues: readonly string[]): string {
  const list = issues
    .slice(0, 5)
    .map((issue) => `- ${issue}`)
    .join('\n');
  return `Some automated checks did not pass on the last version. Please fix them without changing anything else:\n${list}`;
}
