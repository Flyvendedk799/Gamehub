/**
 * Give a replayed run event the time it really happened.
 *
 * The worker's frames carry no timestamp, so a client stamps them when they ARRIVE. Live, that is
 * close enough. On a reload the whole history arrives in one burst, so every frame would read as
 * "just now" and a finished run would claim it had worked for however long ago it was asked.
 * `run_events` knows the real time of each row; hand it to the client for the frames that the chat
 * uses to time a turn.
 */
const TIMED_TYPES = new Set([
  'progress',
  'summary',
  'draft_ready',
  'run_complete',
  'run_error',
  'run_paused',
]);

export function withReplayTimestamp(event: unknown, createdAt: Date | string): unknown {
  if (event === null || typeof event !== 'object') return event;
  const frame = event as { type?: unknown; timestamp?: unknown };
  if (typeof frame.type !== 'string' || !TIMED_TYPES.has(frame.type)) return event;
  if (typeof frame.timestamp === 'string') return event;
  const at = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return { ...frame, timestamp: at };
}
