// ─── Domain types ────────────────────────────────────────────────────────────

export type Engine = 'phaser' | 'threejs' | 'vanilla';

export interface Project {
  id: string;
  name: string;
  engine: Engine;
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

export interface ToolUseEvent {
  type: 'tool_use';
  runId: string;
  toolName: string;
  status: 'start' | 'done' | 'error';
  input?: Record<string, unknown>;
  timestamp: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  runId: string;
  toolName: string;
  success: boolean;
  timestamp: string;
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  runId: string;
  delta: string;
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
  | ToolUseEvent
  | ToolResultEvent
  | ThinkingDeltaEvent;

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
