/**
 * Echo the edited region back in the edit result.
 *
 * An edit used to answer only "New content at lines 118-142 (file is now 640
 * lines)". True, and useless — the model cannot see what it wrote, so it calls
 * `view` to check. That confirming read is a full model round trip, roughly
 * eleven seconds, and it happens after nearly every edit.
 *
 * Run 5f7e6510 made 86 `view` calls against 30 mutations of the same file. Some
 * of those were the pruner dropping state (fixed in `file-coverage.ts`); the
 * rest were this — looking at work the tool could simply have shown.
 *
 * So a successful edit now returns the lines it produced, numbered, with a
 * little context either side. The model sees the result of its own edit without
 * asking, and the next tool call can be the next *edit* rather than a look.
 *
 * Bounded on purpose. The point is to remove a round trip, not to paste a file
 * into the transcript: a large edit is elided in the middle, keeping the head
 * and tail, which is where anchors and syntax errors live.
 */

export interface EchoOptions {
  /** Lines of unchanged context shown either side of the edit. */
  readonly context?: number | undefined;
  /** Most lines to print before eliding the middle. */
  readonly maxLines?: number | undefined;
  /** Byte ceiling; the echo is dropped entirely past this. */
  readonly maxBytes?: number | undefined;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 60;
const DEFAULT_MAX_BYTES = 4096;

function gutter(lineNumber: number, width: number): string {
  return `${String(lineNumber).padStart(width, ' ')} | `;
}

/**
 * Render lines `startLine`-`endLine` (1-based, inclusive) with context.
 *
 * Returns an empty string when there is nothing useful to show, so callers can
 * append unconditionally.
 */
export function echoEditedRegion(
  content: string,
  startLine: number,
  endLine: number,
  options: EchoOptions = {},
): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return '';

  const contextLines = Math.max(0, options.context ?? DEFAULT_CONTEXT);
  const maxLines = Math.max(4, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES);

  const lines = content.split('\n');
  const from = Math.max(1, Math.min(startLine, lines.length) - contextLines);
  const to = Math.min(lines.length, Math.max(startLine, endLine) + contextLines);
  if (to < from) return '';

  const width = String(to).length;
  const span = to - from + 1;

  const render = (numbers: number[]): string =>
    numbers.map((n) => `${gutter(n, width)}${lines[n - 1] ?? ''}`).join('\n');

  let body: string;
  if (span <= maxLines) {
    body = render(Array.from({ length: span }, (_, i) => from + i));
  } else {
    // Keep both ends: the head carries the anchor the next edit will target,
    // the tail carries the unbalanced brace if there is one.
    const head = Math.ceil((maxLines - 1) / 2);
    const tail = maxLines - 1 - head;
    const headNumbers = Array.from({ length: head }, (_, i) => from + i);
    const tailNumbers = Array.from({ length: tail }, (_, i) => to - tail + 1 + i);
    const hidden = span - head - tail;
    body = `${render(headNumbers)}\n… ${hidden} lines not shown …\n${render(tailNumbers)}`;
  }

  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // Past this, echoing costs more than the round trip it saves.
    return '';
  }
  return body;
}

/**
 * The full block appended to an edit result.
 *
 * Says explicitly that a confirming `view` is unnecessary — the model has been
 * trained by every other tool to go and check, and the cheapest way to stop it
 * is to say so at the moment it would decide.
 */
export function formatEditEcho(
  path: string,
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
  options: EchoOptions = {},
): string {
  if (startLine === undefined || endLine === undefined) return '';
  const body = echoEditedRegion(content, startLine, endLine, options);
  if (body.length === 0) return '';
  return `\n\nThe file now reads (no need to \`view\` — this is the current state of \`${path}\`):\n${body}`;
}
