/**
 * Chat-history → SSE-event hydration. Maps persisted chat rows back into the
 * `SseEvent` shapes the builder log renders, so a reloaded page reconstructs the
 * conversation. Extracted from the builder page so it can be unit-tested (#16).
 *
 * User turns hydrate as a real `user_message` event (#34) — not a
 * `message_update` with a `> ` prefix as the old hack did.
 */

import type { ChatHistoryMessage, SseEvent } from './types';

export function chatMessageToEvents(msg: ChatHistoryMessage): SseEvent[] {
  if (msg.kind === 'user') {
    const p = msg.payload as { text?: string; runId?: string } | null;
    return [
      {
        type: 'user_message',
        runId: p?.runId ?? '',
        content: p?.text ?? '',
        timestamp: msg.createdAt,
      },
    ];
  }
  if (msg.kind === 'artifact_delivered') {
    const p = msg.payload as { runId?: string; previewUrl?: string } | null;
    return [
      {
        type: 'run_complete',
        runId: p?.runId ?? '',
        snapshotPath: '',
        previewUrl: p?.previewUrl ?? '',
        timestamp: msg.createdAt,
      },
    ];
  }
  // Phase 2.5 — a `continuation_pending` row means a long run paused at a safe
  // boundary. Hydrating it as a `run_paused` event makes the Resume button
  // reappear after a reload; resuming re-fires generateGame (the server
  // auto-applies the stored continuation).
  if (msg.kind === 'continuation_pending') {
    const p = msg.payload as { runId?: string; question?: string } | null;
    return [
      {
        type: 'run_paused',
        runId: p?.runId ?? '',
        timestamp: msg.createdAt,
        ...(p?.question ? { question: p.question } : {}),
      },
    ];
  }
  return [];
}

/**
 * Hydrate a full chat history into builder-log events, deduping the chat-derived
 * terminal (`run_complete` / `run_paused`) for the run that the live SSE stream
 * is replaying. That stream provides its own authoritative terminal (real or
 * synthesized server-side), so keeping the chat copy too renders the run's
 * "complete"/"paused" card twice — and a duplicate Resume affordance for a paused
 * run. `streamRunId` is the run being streamed (from the `?runId=` URL OR the
 * active-run lookup used to re-attach after a reload); pass null when nothing is
 * being streamed, in which case every row is kept.
 */
export function hydrateHistoryEvents(
  messages: ChatHistoryMessage[],
  streamRunId: string | null,
): SseEvent[] {
  const out: SseEvent[] = [];
  for (const msg of messages) {
    if (
      streamRunId &&
      (msg.kind === 'artifact_delivered' || msg.kind === 'continuation_pending') &&
      (msg.payload as { runId?: string } | null)?.runId === streamRunId
    ) {
      continue;
    }
    out.push(...chatMessageToEvents(msg));
  }
  return out;
}

/** Extracts the last delivered preview URL from a chat history, if any. */
export function lastPreviewUrlFromHistory(messages: ChatHistoryMessage[]): string | null {
  let last: string | null = null;
  for (const msg of messages) {
    if (msg.kind === 'artifact_delivered') {
      const p = msg.payload as { previewUrl?: string } | null;
      if (p?.previewUrl) last = p.previewUrl;
    }
  }
  return last;
}
