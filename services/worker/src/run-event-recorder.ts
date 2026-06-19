/**
 * RunEventRecorder — the single chokepoint that both STREAMS a run's events to
 * the live bus AND durably persists them to `run_events` so the build log
 * survives a refresh / API restart (see schema `runEvents`).
 *
 * Two delivery channels with deliberately different granularity:
 *   • LIVE (bus.publish): every raw frame, including each assistant text delta,
 *     so the browser sees real-time typing.
 *   • DURABLE (persist): the same tool / spec / terminal frames, but consecutive
 *     assistant text deltas are COALESCED into ONE `message_update` row per turn
 *     — one row per turn instead of one per token keeps the table compact while
 *     a reload still reconstructs the narration.
 *
 * Persistence is best-effort and fire-and-forget on the agent's hot path: a lost
 * DB write logs and is dropped, never throws into the generation loop. `seq` is
 * assigned synchronously so ordering is correct regardless of async completion
 * order, and the (run_id, seq) UNIQUE + onConflictDoNothing makes a retry safe.
 */
import type { AgentEvent } from '@playforge/agent-core';
import { type EventBus, runChannel } from '@playforge/bus';

export interface PersistRunEventInput {
  runId: string;
  projectId: string;
  seq: number;
  event: unknown;
}

/** Best-effort durable sink for a single recorded event. */
export type PersistRunEventFn = (input: PersistRunEventInput) => void | Promise<void>;

/** Extract the assistant text delta from a raw `message_update` frame, if any. */
export function textDeltaOf(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;
  if (e['type'] !== 'message_update') return null;
  const ame = e['assistantMessageEvent'];
  if (!ame || typeof ame !== 'object') return null;
  const a = ame as Record<string, unknown>;
  if (a['type'] !== 'text_delta') return null;
  const delta = a['delta'] ?? a['text'];
  return typeof delta === 'string' && delta.length > 0 ? delta : null;
}

function coalescedTextFrame(text: string): unknown {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } };
}

export class RunEventRecorder {
  private seq = 0;
  private textBuffer = '';
  private readonly channel: string;

  constructor(
    private readonly runId: string,
    private readonly projectId: string,
    private readonly bus: EventBus,
    private readonly persist?: PersistRunEventFn,
  ) {
    this.channel = runChannel(runId);
  }

  /**
   * Record a live agent event: published raw for real-time UX; persisted with
   * text coalesced. Non-blocking — a publish/persist failure must not kill the
   * agent loop.
   */
  onAgentEvent(event: AgentEvent): void {
    void this.bus.publish(this.channel, event).catch((err: unknown) => {
      console.error(
        `[run:${this.runId}] live publish failed:`,
        err instanceof Error ? err.message : err,
      );
    });

    const text = textDeltaOf(event);
    if (text !== null) {
      this.textBuffer += text;
      return;
    }
    this.flushTextPersist();
    this.persistEvent(event);
  }

  /**
   * Record a terminal / control frame (run_complete / run_error / run_paused).
   * Awaited so the caller knows the live publish was attempted before returning.
   */
  async control(event: { type: string; [k: string]: unknown }): Promise<void> {
    this.flushTextPersist();
    await this.bus.publish(this.channel, event);
    this.persistEvent(event);
  }

  /** Persist any buffered assistant text as one coalesced row, then reset. */
  private flushTextPersist(): void {
    if (this.textBuffer.length === 0) return;
    const frame = coalescedTextFrame(this.textBuffer);
    this.textBuffer = '';
    this.persistEvent(frame);
  }

  private persistEvent(event: unknown): void {
    if (!this.persist) return;
    const seq = this.seq++;
    Promise.resolve(
      this.persist({ runId: this.runId, projectId: this.projectId, seq, event }),
    ).catch((err: unknown) => {
      console.error(
        `[run:${this.runId}] event persist (seq=${seq}) failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}
