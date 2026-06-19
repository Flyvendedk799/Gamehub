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

/** Join the `{type:'text'}` parts of a completions-style message snapshot's
 *  `content[]`, ignoring toolCall items. Returns null when there's no prose. */
function snapshotTextOf(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;
  if (e['type'] !== 'message_update') return null;
  const msg = e['message'];
  if (!msg || typeof msg !== 'object') return null;
  const content = (msg as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object') {
      const c = item as Record<string, unknown>;
      if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].length > 0) {
        parts.push(c['text']);
      }
    }
  }
  const joined = parts.join('').trim();
  return joined.length > 0 ? joined : null;
}

/** The assistant narration carried by an event, with how to fold it: append-only
 *  text deltas (Anthropic) vs. full-snapshot replaces (openai-completions). */
function narrationOf(event: unknown): { mode: 'append' | 'replace'; text: string } | null {
  const delta = textDeltaOf(event);
  if (delta !== null) return { mode: 'append', text: delta };
  const snapshot = snapshotTextOf(event);
  if (snapshot !== null) return { mode: 'replace', text: snapshot };
  return null;
}

function coalescedTextFrame(text: string): unknown {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } };
}

/**
 * Streaming / agent-loop internals that carry no renderable build-feed signal:
 * per-token assistant `message_update` SNAPSHOTS (the openai-completions shape is
 * a full growing message, not a renderable `text_delta` — those are handled by
 * the coalescer above), message envelope frames, and turn markers. They are
 * still PUBLISHED live (the browser filters them) but must NOT be persisted —
 * one real run emitted ~9k message_update snapshots, which would bloat
 * `run_events` and make a refresh replay enormous for zero visible gain.
 */
const NON_PERSISTED_TYPES: ReadonlySet<string> = new Set([
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'message_update',
]);

/** Per-turn debug trace to the API/worker stdout (→ survhub logs). On by
 *  default so a run is fully inspectable; set GEN_DEBUG=0 to silence. */
const GEN_DEBUG = process.env['GEN_DEBUG'] !== '0';

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const s = (k: string): string | undefined =>
    typeof a[k] === 'string' ? (a[k] as string) : undefined;
  switch (toolName) {
    case 'str_replace_based_edit_tool':
      return `${s('command') ?? '?'} ${s('path') ?? '?'}`;
    case 'declare_game_spec':
    case 'amend_game_spec':
      return `genre=${s('genre') ?? '?'}`;
    case 'choose_engine':
      return s('engine') ?? '';
    case 'generate_image_asset':
    case 'generate_audio_asset':
      return s('purpose') ?? '';
    case 'ask_user':
      return `"${s('question') ?? ''}"`;
    case 'set_todos': {
      const items = a['items'];
      return Array.isArray(items) ? `${items.length} items` : '';
    }
    default:
      return s('path') ?? '';
  }
}

/** Pull a short failure/verdict summary out of a tool result (verify/done carry
 *  their issues in details.errors; others put a message in content[].text). */
function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const details = r['details'] as Record<string, unknown> | undefined;
  const errs = details?.['errors'];
  if (Array.isArray(errs) && errs.length > 0) {
    return errs
      .map((e) => (e as { message?: string })?.message ?? '')
      .filter(Boolean)
      .slice(0, 3)
      .join(' | ')
      .slice(0, 260);
  }
  const content = r['content'];
  if (Array.isArray(content)) {
    const txt = content
      .map((c) => (c as { text?: string })?.text ?? '')
      .filter(Boolean)
      .join(' ');
    if (txt) return txt.slice(0, 200);
  }
  return '';
}

export class RunEventRecorder {
  private seq = 0;
  private turnNo = 0;
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
    this.debugLog(event);
    void this.bus.publish(this.channel, event).catch((err: unknown) => {
      console.error(
        `[run:${this.runId}] live publish failed:`,
        err instanceof Error ? err.message : err,
      );
    });

    // Accumulate the assistant's narration (append deltas / replace snapshots)
    // for durable persistence — one coalesced block per turn, not per token.
    const narration = narrationOf(event);
    if (narration !== null) {
      if (narration.mode === 'append') this.textBuffer += narration.text;
      else this.textBuffer = narration.text;
      return;
    }
    const type = (event as { type?: string }).type ?? '';
    // A turn boundary finalizes the current narration block.
    if (type === 'turn_end') {
      this.flushTextPersist();
      return;
    }
    // Drop the remaining streaming/loop internals from the durable log (still
    // streamed live). A tool-only `message_update` snapshot reaches here too.
    if (NON_PERSISTED_TYPES.has(type)) return;
    // Persist the narration BEFORE this meaningful event (e.g. a tool call) so
    // the feed reads "said what it's doing → did it", in order.
    this.flushTextPersist();
    this.persistEvent(event);
  }

  /**
   * Record a terminal / control frame (run_complete / run_error / run_paused).
   * Awaited so the caller knows the live publish was attempted before returning.
   */
  async control(event: { type: string; [k: string]: unknown }): Promise<void> {
    this.flushTextPersist();
    if (GEN_DEBUG) {
      const extra =
        typeof event['error'] === 'string'
          ? `: ${event['error'].slice(0, 200)}`
          : typeof event['question'] === 'string'
            ? `: "${event['question']}"`
            : '';
      console.log(`[gen:${this.runId.slice(0, 8)}] ■ ${event.type}${extra}`);
    }
    await this.bus.publish(this.channel, event);
    this.persistEvent(event);
  }

  /** Persist any buffered assistant text as one coalesced row, then reset. */
  private flushTextPersist(): void {
    if (this.textBuffer.length === 0) return;
    if (GEN_DEBUG) {
      console.log(
        `[gen:${this.runId.slice(0, 8)}]   💭 ${this.textBuffer.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
      );
    }
    const frame = coalescedTextFrame(this.textBuffer);
    this.textBuffer = '';
    this.persistEvent(frame);
  }

  /**
   * Per-turn debug trace (GEN_DEBUG): turn boundaries, every tool call with a
   * concise arg summary, and tool failures / verify+done verdicts with their
   * reasons — so a run is fully inspectable in the API logs without replaying
   * the raw 9k-frame stream. Thoughts are logged in flushTextPersist; terminal
   * frames in control().
   */
  private debugLog(event: unknown): void {
    if (!GEN_DEBUG) return;
    const e = event as Record<string, unknown>;
    const type = e['type'];
    const tag = `[gen:${this.runId.slice(0, 8)}]`;
    if (type === 'turn_start') {
      this.turnNo += 1;
      console.log(`${tag} ┌─ turn ${this.turnNo}`);
      return;
    }
    if (type === 'tool_execution_start') {
      const name = String(e['toolName'] ?? '?');
      const args = summarizeToolArgs(name, e['args']);
      console.log(`${tag}   ▶ ${name}${args ? ` (${args})` : ''}`);
      return;
    }
    if (type === 'tool_execution_end') {
      const name = String(e['toolName'] ?? '?');
      const isError = e['isError'] === true;
      // Always surface the verdict tools (their has_errors lives in details even
      // when isError=false) plus any genuine tool error; stay quiet otherwise.
      const isVerdictTool =
        name === 'verify_artifact' || name === 'done' || name === 'validate_game_scene';
      if (isError || isVerdictTool) {
        const summary = summarizeToolResult(e['result']);
        console.log(`${tag}   ${isError ? '✗' : '✓'} ${name}${summary ? `: ${summary}` : ''}`);
      }
    }
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
