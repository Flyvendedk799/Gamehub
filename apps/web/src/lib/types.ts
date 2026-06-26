// ─── Domain types ────────────────────────────────────────────────────────────

export type Engine = 'phaser' | 'threejs' | 'vanilla';

export interface Project {
  id: string;
  name: string;
  engine: Engine;
  /** Gameplay thumbnail (`/v1/blobs/:key`) captured after the latest build; null
   *  until the first build completes — the card falls back to a placeholder. */
  thumbnailUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  prompt: string;
  createdAt: string;
  updatedAt: string;
  snapshotPath?: string;
}

// ─── SSE event types ─────────────────────────────────────────────────────────

export interface AgentStartEvent {
  type: 'agent_start';
  runId: string;
  timestamp: string;
}

export interface TurnStartEvent {
  type: 'turn_start';
  runId: string;
  turnIndex: number;
  timestamp: string;
}

export interface TurnEndEvent {
  type: 'turn_end';
  runId: string;
  turnIndex: number;
  timestamp: string;
}

export interface AgentEndEvent {
  type: 'agent_end';
  runId: string;
  timestamp: string;
}

export interface RunCompleteEvent {
  type: 'run_complete';
  runId: string;
  snapshotPath: string;
  previewUrl: string;
  timestamp: string;
}

export interface RunErrorEvent {
  type: 'run_error';
  runId: string;
  error: string;
  timestamp: string;
}

export interface MessageUpdateEvent {
  type: 'message_update';
  runId: string;
  role: 'assistant' | 'tool';
  content: string;
  timestamp: string;
}

/**
 * A real user turn in the chat log. Replaces the prior hack of pushing a
 * `message_update` with a `> ` prefix to mark user input (#34). Client-synthesized
 * (the server doesn't emit this over SSE); rendered as a distinct bubble.
 */
export interface UserMessageEvent {
  type: 'user_message';
  runId: string;
  content: string;
  timestamp: string;
}

export interface TextDeltaEvent {
  type: 'text_delta';
  runId: string;
  delta: string;
  timestamp: string;
}

/**
 * The assistant's narration as a FULL snapshot of the current message text.
 * Providers that stream completions (openai-completions, e.g. o4-mini) emit a
 * growing `message.content[]` rather than append-only `text_delta`s, so each
 * frame carries the whole text so far. The render layer REPLACES the in-progress
 * narration block with the latest snapshot (vs. appending text_delta). This is
 * what surfaces the AI's "thoughts / what it's doing" prose in the build feed.
 */
export interface AssistantTextEvent {
  type: 'assistant_text';
  runId: string;
  text: string;
  timestamp: string;
}

export interface ToolUseEvent {
  type: 'tool_use';
  runId: string;
  toolName: string;
  status: 'start' | 'done' | 'error';
  input?: Record<string, unknown>;
  /** Human-readable activity label, e.g. "writing src/main.ts" (Phase 2.1). */
  label?: string;
  /** File path being written, when this tool writes a file (Phase 2.1/2.6). */
  path?: string;
  timestamp: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  runId: string;
  toolName: string;
  success: boolean;
  /** Human-readable label carried through from the matching tool_use (2.1). */
  label?: string;
  /** File path written by this tool, when applicable (2.6 "Changed N files"). */
  path?: string;
  timestamp: string;
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  runId: string;
  delta: string;
  timestamp: string;
}

/**
 * The agent's declared game spec (Phase 2.2). Synthesized from a
 * `declare_game_spec` / `amend_game_spec` tool-execution event so the builder
 * can render a "here's what I'm building" card before `run_complete`. Fields
 * mirror the `@playforge/shared` GameSpec but are all optional — the agent may
 * amend only part of the spec.
 */
export interface GameSpecEvent {
  type: 'game_spec';
  runId: string;
  genre?: string;
  winCondition?: string;
  loseCondition?: string;
  /** True when this came from `amend_game_spec` (a partial patch). */
  amend: boolean;
  timestamp: string;
}

/**
 * The backend paused a long run at a safe boundary (Phase 2.5). The server
 * publishes `{ type: 'run_paused' }` then closes the stream; the builder shows
 * a Resume button that re-fires generateGame (the server auto-applies the
 * stored continuation). Client-normalized to carry runId/timestamp.
 */
export interface RunPausedEvent {
  type: 'run_paused';
  runId: string;
  /** WS-D — set when the agent paused to ask a clarifying question (ask_user).
   *  The builder shows it with an answer box that resumes the run. */
  question?: string;
  timestamp: string;
}

/**
 * The agent's live build plan, synthesized from a `set_todos` tool call. Shown
 * as an updating checklist ("here's my plan / what I'm doing") so the feed reads
 * as a narrative instead of raw tool chips. The latest plan replaces the prior
 * one in the render layer.
 */
export interface PlanEvent {
  type: 'plan';
  runId: string;
  items: Array<{ text: string; checked: boolean }>;
  timestamp: string;
}

export type SseEvent =
  | AgentStartEvent
  | TurnStartEvent
  | TurnEndEvent
  | AgentEndEvent
  | RunCompleteEvent
  | RunErrorEvent
  | MessageUpdateEvent
  | UserMessageEvent
  | TextDeltaEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | ThinkingDeltaEvent
  | GameSpecEvent
  | PlanEvent
  | RunPausedEvent;

// ─── Chat history ─────────────────────────────────────────────────────────────

export interface ChatHistoryMessage {
  id: number;
  projectId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface ChatHistoryResponse {
  messages: ChatHistoryMessage[];
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface CreateProjectResponse {
  project: Project;
}

export interface ListProjectsResponse {
  projects: Project[];
}

export interface GetProjectResponse {
  project: Project;
}

export interface GenerateGameResponse {
  runId: string;
  run: Run;
}
