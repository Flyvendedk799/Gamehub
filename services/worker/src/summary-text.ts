/**
 * The closing message of a run, cleaned for the chat.
 *
 * Runs end with different text: the host's own bullets for an edit, the agent's closing message
 * after a loop, or a built-in line ("— Stopped after 44 steps. The project above is what landed;
 * send a follow-up message... —") when a run hit a limit. The chat shows one tidy summary, so the
 * limit boilerplate is stripped and the length capped. Returns null when nothing worth showing is
 * left.
 */
export function cleanSummary(message: string | undefined | null, maxChars = 1500): string | null {
  if (message === undefined || message === null) return null;
  let text = message
    // "— Stopped after 44 steps. ... —" / "— Paused after 1200s of work ... —"
    .replace(/\s*—\s*(?:Stopped|Paused) after[\s\S]*?—\s*$/u, '')
    .trim();
  if (text.length < 8) return null;
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}…`;
  return text;
}

/** One row to append to the project's chat history when a run completes. */
export interface CompletedRunChatRow {
  kind: 'assistant_text' | 'artifact_delivered';
  payload: Record<string, unknown>;
}

/**
 * The chat rows a completed run leaves behind, in order: the agent's reply (so a reloaded chat
 * still reads as a conversation, not just a list of "version ready" cards), then the delivery
 * card. The reply is omitted when the run said nothing worth keeping.
 */
export function chatRowsForCompletedRun(args: {
  runId: string;
  message: string | undefined | null;
  engine: string | null;
  snapshotId: string | null;
  quality: unknown;
  files?: readonly string[] | undefined;
}): CompletedRunChatRow[] {
  const rows: CompletedRunChatRow[] = [];
  const text = cleanSummary(args.message);
  if (text !== null) {
    const files = args.files ?? [];
    rows.push({
      kind: 'assistant_text',
      payload: { runId: args.runId, text, ...(files.length > 0 ? { files: [...files] } : {}) },
    });
  }
  rows.push({
    kind: 'artifact_delivered',
    payload: {
      runId: args.runId,
      previewUrl: `/v1/runs/${args.runId}/preview/`,
      engine: args.engine,
      snapshotId: args.snapshotId,
      quality: args.quality ?? null,
    },
  });
  return rows;
}
