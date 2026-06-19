/**
 * Agent SSE-frame normalizer (Phase 2.1 — KEYSTONE).
 *
 * The generation worker publishes the raw pi-agent-core event stream over the
 * bus, and the API relays each frame verbatim. Those raw frames use the
 * agent's own wire vocabulary — `tool_execution_start`, `tool_execution_end`,
 * and `message_update` (whose text lives under `assistantMessageEvent`). The
 * builder log renders the project's own `SseEvent` union instead, so without a
 * mapping layer the most-watched surface during a build (the build log) drops
 * every tool call and every streamed token — it looks near-empty.
 *
 * This module is the bridge: it maps each raw agent frame to zero-or-more
 * renderable `SseEvent`s.
 *
 *   tool_execution_start  → tool_use  (status:'start') + optional game_spec
 *   tool_execution_end    → tool_result (success = !isError)
 *   message_update        → text_delta (unwrapping assistantMessageEvent)
 *   run_paused            → run_paused (Phase 2.5)
 *
 * Pure + exported so the mapping is unit-tested without a live EventSource.
 *
 * IMPORTANT — wire shape (confirmed against the worker/agent source):
 *  - tool_execution_start carries `toolName`, `args`, `toolCallId` at the TOP
 *    level (NOT under `toolCall`).
 *  - tool_execution_end carries `toolCallId`, `isError`, `result`.
 *  - message_update carries `assistantMessageEvent: { type, delta?|text? }`.
 *  - the bus messages do NOT carry a `runId` field — the API relay forwards
 *    `{ type: 'run_complete' }` etc. unchanged, so we synthesize runId here.
 */

import type { SseEvent } from './types';

/** Raw agent wire-frame types that the normalizer understands. */
export const RAW_AGENT_TYPES = [
  'tool_execution_start',
  'tool_execution_end',
  'message_update',
  'run_paused',
] as const;

export type RawAgentType = (typeof RAW_AGENT_TYPES)[number];

export function isRawAgentType(type: string): type is RawAgentType {
  return (RAW_AGENT_TYPES as readonly string[]).includes(type);
}

/** The file-writing edit tool used by the agent. */
const EDIT_TOOL = 'str_replace_based_edit_tool';
/** Edit-tool commands that produce/modify a file. */
const WRITE_COMMANDS = new Set(['create', 'str_replace', 'insert', 'patch']);
const SPEC_TOOLS = new Set(['declare_game_spec', 'amend_game_spec']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extract the file path written by a tool call, if any. Today only the
 * agent's str_replace_based_edit_tool writes files (via a `path` arg on a
 * create/str_replace/insert/patch command); future tools can be added here.
 */
export function writePathFromTool(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName !== EDIT_TOOL) return undefined;
  const command = args['command'];
  if (typeof command !== 'string' || !WRITE_COMMANDS.has(command)) return undefined;
  return str(args['path']);
}

/**
 * Human-readable activity label for a tool call, keyed on toolName so the
 * build log reads like a narration of the build ("writing <path>",
 * "validating scene", "playtesting", "choosing engine") instead of a raw
 * tool name.
 */
export function toolActivityLabel(toolName: string, args: Record<string, unknown>): string {
  const writePath = writePathFromTool(toolName, args);
  if (writePath) return `writing ${writePath}`;

  switch (toolName) {
    case EDIT_TOOL: {
      // Non-write edit command (e.g. `view`).
      const path = str(args['path']);
      return path ? `reading ${path}` : 'reading the project files';
    }
    case 'validate_game_scene':
      return 'checking the scene for errors';
    case 'playtest_game':
      return 'playtesting the game in a browser';
    case 'choose_engine': {
      const engine = str(args['engine']);
      return engine ? `choosing engine — ${engine}` : 'choosing the game engine';
    }
    case 'declare_game_spec':
      return 'defining the game design';
    case 'amend_game_spec':
      return 'revising the game design';
    case 'verify_artifact':
      return 'verifying the build';
    case 'set_todos':
      return 'planning the build steps';
    case 'read_url':
      return 'reading a reference';
    case 'generate_image_asset': {
      const purpose = str(args['purpose']);
      return purpose ? `generating art — ${purpose}` : 'generating game art';
    }
    case 'done':
      return 'finalizing the build';
    default:
      // Fall back to a readable form of the raw name: snake_case → words.
      return toolName.replace(/_/g, ' ');
  }
}

/**
 * Outcome label for a FINISHED tool call. The build log previously reused the
 * start label for the result chip too, so a single step rendered as the same
 * text twice ("playtesting" then "playtesting") — which reads as confusing
 * repetition rather than progress. This gives the result chip its own concise,
 * past-tense outcome ("playtest passed" / "playtest found problems"), so each
 * step narrates start → result.
 */
export function toolResultLabel(
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
): string {
  const writePath = writePathFromTool(toolName, args);
  if (writePath) return success ? `wrote ${writePath}` : `couldn't write ${writePath}`;

  switch (toolName) {
    case EDIT_TOOL:
      return success ? 'read the files' : "couldn't read the files";
    case 'validate_game_scene':
      return success ? 'scene looks good' : 'scene has issues to fix';
    case 'playtest_game':
      return success ? 'playtest passed' : 'playtest found problems';
    case 'choose_engine': {
      const engine = str(args['engine']);
      return engine ? `engine ready — ${engine}` : 'engine selected';
    }
    case 'declare_game_spec':
    case 'amend_game_spec':
      return success ? 'game design set' : "couldn't set the game design";
    case 'verify_artifact':
      return success ? 'build verified' : 'build needs fixes';
    case 'set_todos':
      return 'plan updated';
    case 'read_url':
      return success ? 'reference read' : "couldn't read the reference";
    case 'generate_image_asset':
      return success ? 'art ready' : 'art unavailable — using a placeholder';
    case 'done':
      return success ? 'build finalized' : 'build still has errors';
    default: {
      const words = toolName.replace(/_/g, ' ');
      return success ? `${words} done` : `${words} failed`;
    }
  }
}

/** Build a game_spec SseEvent from a declare/amend tool's args, if it has one. */
function gameSpecEventFromArgs(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  timestamp: string,
): SseEvent | null {
  if (!SPEC_TOOLS.has(toolName)) return null;
  const genre = str(args['genre']);
  const winCondition = str(args['winCondition']);
  const loseCondition = str(args['loseCondition']);
  // Only surface a card when there is something worth showing.
  if (!genre && !winCondition && !loseCondition) return null;
  return {
    type: 'game_spec',
    runId,
    amend: toolName === 'amend_game_spec',
    timestamp,
    ...(genre !== undefined ? { genre } : {}),
    ...(winCondition !== undefined ? { winCondition } : {}),
    ...(loseCondition !== undefined ? { loseCondition } : {}),
  };
}

export interface NormalizeContext {
  /** Run id to stamp on synthesized events (wire frames omit it). */
  runId: string;
  /** Timestamp to stamp; defaults to now. */
  timestamp?: string;
}

/**
 * Map a single raw agent wire-frame (already JSON-parsed into an object) into
 * the renderable `SseEvent`s it represents. Returns `[]` for frames that carry
 * no renderable signal (e.g. a message_update with an empty/non-text delta).
 */
export function normalizeAgentFrame(
  frame: Record<string, unknown>,
  ctx: NormalizeContext,
): SseEvent[] {
  const type = frame['type'];
  if (typeof type !== 'string') return [];
  const runId = ctx.runId;
  const timestamp = ctx.timestamp ?? new Date().toISOString();

  switch (type) {
    case 'tool_execution_start': {
      const toolName = str(frame['toolName']);
      if (!toolName) return [];
      const args = asRecord(frame['args']);
      const path = writePathFromTool(toolName, args);
      const label = toolActivityLabel(toolName, args);
      const out: SseEvent[] = [
        {
          type: 'tool_use',
          runId,
          toolName,
          status: 'start',
          input: args,
          label,
          timestamp,
          ...(path !== undefined ? { path } : {}),
        },
      ];
      // Phase 2.2 — surface the declared spec as a "here's what I'm building"
      // card. The spec is carried in the declare/amend tool's args.
      const spec = gameSpecEventFromArgs(runId, toolName, args, timestamp);
      if (spec) out.push(spec);
      return out;
    }

    case 'tool_execution_end': {
      const toolName = str(frame['toolName']) ?? 'tool';
      const success = frame['isError'] !== true;
      const args = asRecord(frame['args']);
      const path = writePathFromTool(toolName, args);
      const label = toolResultLabel(toolName, args, success);
      return [
        {
          type: 'tool_result',
          runId,
          toolName,
          success,
          label,
          timestamp,
          ...(path !== undefined ? { path } : {}),
        },
      ];
    }

    case 'message_update': {
      const ame = asRecord(frame['assistantMessageEvent']);
      if (ame['type'] !== 'text_delta') return [];
      const delta = str(ame['delta']) ?? str(ame['text']);
      if (!delta) return [];
      return [{ type: 'text_delta', runId, delta, timestamp }];
    }

    case 'run_paused': {
      return [{ type: 'run_paused', runId, timestamp }];
    }

    default:
      return [];
  }
}

/**
 * The exact message the builder shows when the SSE stream is lost for good
 * (the `onGiveUp` transport case). Kept here so the Fix-gating predicate (2.3)
 * and the builder stay in lockstep on the one string that must NOT offer a Fix.
 */
export const TRANSPORT_LOST_MESSAGE = 'Lost connection to the build stream. Reload to resume.';

/** True when an error string is the transport "lost connection" case (2.3). */
export function isTransportError(message: string): boolean {
  return message === TRANSPORT_LOST_MESSAGE;
}

/**
 * Phase 2.3 gating — should a run_error row offer a one-click "Fix this error"?
 * Yes for a genuine build failure; NO for the transport "Lost connection" case
 * (re-prompting can't fix a dropped socket — the user reloads to resume). In
 * practice the transport case never even becomes a run_error event (it sets the
 * builder's error banner via onGiveUp), so this is belt-and-suspenders that
 * also keeps the rule unit-testable.
 */
export function shouldOfferFix(event: SseEvent): boolean {
  return event.type === 'run_error' && !isTransportError(event.error);
}

/**
 * Collect the file paths written across a run's events (Phase 2.6). Reads the
 * normalized `tool_result` rows (each successful write carries its `path`) and
 * returns the unique paths in first-seen order, so the completion row can list
 * "Changed N files".
 */
export function writtenPaths(events: readonly SseEvent[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const ev of events) {
    if (ev.type === 'tool_result' && ev.success && ev.path) {
      if (!seen.has(ev.path)) {
        seen.add(ev.path);
        order.push(ev.path);
      }
    }
  }
  return order;
}
