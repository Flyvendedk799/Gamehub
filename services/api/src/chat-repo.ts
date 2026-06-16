/**
 * Chat message repository. Stores the per-project turn log (user prompts,
 * assistant text, tool calls, artifact notifications) so the builder UI can
 * reload history after a page refresh. Drizzle-backed in production; in-memory
 * for tests.
 */
import type { ChatMessageKind } from '@playforge/shared';

export interface ChatMessage {
  id: number;
  projectId: string;
  seq: number;
  kind: ChatMessageKind;
  payload: unknown;
  createdAt: string;
}

export interface ChatRepo {
  add(projectId: string, kind: ChatMessageKind, payload: unknown): Promise<ChatMessage>;
  list(projectId: string): Promise<ChatMessage[]>;
}

export class InMemoryChatRepo implements ChatRepo {
  private readonly byProject = new Map<string, ChatMessage[]>();
  private nextId = 0;

  async add(projectId: string, kind: ChatMessageKind, payload: unknown): Promise<ChatMessage> {
    const existing = this.byProject.get(projectId) ?? [];
    const msg: ChatMessage = {
      id: ++this.nextId,
      projectId,
      seq: existing.length,
      kind,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.byProject.set(projectId, [...existing, msg]);
    return msg;
  }

  async list(projectId: string): Promise<ChatMessage[]> {
    return this.byProject.get(projectId) ?? [];
  }
}
