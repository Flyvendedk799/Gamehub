/**
 * WorkingTree — the cloud implementation of the agent's `fs` dependency
 * (`TextEditorFsCallbacks`). In the desktop base these callbacks were wired to
 * `design_files` SQLite rows; here the agent edits an in-memory tree during a
 * run, and at each turn boundary we serialize it to the content-addressed
 * snapshot store (@playforge/storage) — that's the `fs → object-storage
 * manifest` seam from the plan.
 *
 * Every path is validated with the same traversal guard used by the storage
 * layer, so an untrusted agent (or a remixed project) can't write outside the
 * bundle root.
 */
import { ERROR_CODES, PlayforgeError } from '@playforge/shared';
import {
  type SnapshotInputFile,
  type SnapshotStore,
  type WriteResult,
  assertSafeBundlePath,
} from '@playforge/storage';

export interface EditResult {
  path: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
}

function countLines(s: string): number {
  if (s === '') return 0;
  return s.split('\n').length;
}

/**
 * Find every 0-indexed start position where `block` occurs as a contiguous run
 * of lines inside `lines` (exact, line-by-line). Files are small (hundreds of
 * lines) so a full scan is trivial and lets callers report an accurate match
 * count. Used by `patch` to relocate a hunk whose line range went stale.
 */
function findContiguousBlock(lines: string[], block: string[]): number[] {
  const hits: number[] = [];
  if (block.length === 0 || block.length > lines.length) return hits;
  const last = lines.length - block.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Generated binary assets (sprites, audio) are written into the tree as a
 * base64 data-URL STRING — the image tool calls fs.create with
 * `data:image/png;base64,…`, the audio tool with a mime-less `data:base64,…`.
 * The tree only stores strings, so at PERSIST time we must DECODE those
 * sentinels back to real bytes; otherwise the snapshot stores the literal
 * data-URL text and the preview serves THAT as the file — the browser then
 * can't decode the "PNG"/"WAV", and a failed audio decode throws uncaught out
 * of the game's `create()`, leaving the game half-built. Anchored to the whole
 * string so only a file that IS exactly a base64 data URL is decoded; normal
 * HTML/JS/CSS/JSON content is UTF-8 encoded as before.
 */
const BASE64_DATA_URL = /^data:(?:[\w/+.-]+;)?base64,([\s\S]*)$/;

export function decodeMaybeDataUrl(content: string): Uint8Array {
  const match = BASE64_DATA_URL.exec(content);
  if (match?.[1] !== undefined) return new Uint8Array(Buffer.from(match[1], 'base64'));
  return new TextEncoder().encode(content);
}

/** 1-indexed line on which `offset` falls within `text`. */
function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

export class WorkingTree {
  private readonly files = new Map<string, string>();

  constructor(initial?: Iterable<readonly [string, string]>) {
    if (initial) {
      for (const [path, content] of initial) {
        this.files.set(assertSafeBundlePath(path), content);
      }
    }
  }

  /** TextEditorFsCallbacks.view */
  view(path: string): { content: string; numLines: number } | null {
    assertSafeBundlePath(path);
    const content = this.files.get(path);
    if (content === undefined) return null;
    return { content, numLines: countLines(content) };
  }

  /** TextEditorFsCallbacks.create */
  create(path: string, content: string): { path: string } {
    assertSafeBundlePath(path);
    this.files.set(path, content);
    return { path };
  }

  /** Remove a file from the bundle. Returns true if it existed. Used by the
   *  v3.1 dead-skill sweep to drop a provably-unreferenced staged module. */
  delete(path: string): boolean {
    assertSafeBundlePath(path);
    return this.files.delete(path);
  }

  /** TextEditorFsCallbacks.strReplace — oldStr must occur exactly once. */
  strReplace(path: string, oldStr: string, newStr: string): EditResult {
    const content = this.requireFile(path);
    const first = content.indexOf(oldStr);
    if (first === -1) {
      // Exact match only — we deliberately do NOT auto-apply a whitespace-tolerant
      // match here. The tool layer (text-editor.ts findFuzzyWhitespaceMatch) already
      // detects whitespace drift and surfaces the EXACT file bytes for the model to
      // retry with — which is safe. Auto-applying the model's drifted snippet would
      // silently rewrite indentation (corrupting indent-significant content like
      // GLSL shader strings in template literals); a clean failure is the correct
      // outcome here. (Adversarial review 2026-06-22.)
      throw new PlayforgeError(
        `str_replace: no match for the given text in ${path} (${content.split('\n').length} lines). old_str must match the file content EXACTLY (whitespace + indentation included) and it does not. Recover: \`view\` ${path} and copy the exact snippet, OR \`create\` to rewrite the whole file, OR \`patch\` by line range.`,
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    if (content.indexOf(oldStr, first + 1) !== -1) {
      throw new PlayforgeError(
        `str_replace: text is not unique in ${path} (matched more than once)`,
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    this.files.set(path, updated);
    const startLine = lineAtOffset(updated, first);
    const newLineCount = newStr === '' ? 0 : countLines(newStr);
    return {
      path,
      startLine: newStr === '' ? startLine : startLine,
      endLine: newStr === '' ? startLine - 1 : startLine + newLineCount - 1,
      totalLines: countLines(updated),
    };
  }

  /** TextEditorFsCallbacks.insert — insert `text` after 1-indexed `line` (0 = top). */
  insert(path: string, line: number, text: string): EditResult {
    const content = this.requireFile(path);
    const lines = content === '' ? [] : content.split('\n');
    if (line < 0 || line > lines.length) {
      throw new PlayforgeError(
        `insert: line ${line} out of range (file has ${lines.length} lines)`,
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    const insertedLines = text.split('\n');
    lines.splice(line, 0, ...insertedLines);
    const updated = lines.join('\n');
    this.files.set(path, updated);
    return {
      path,
      startLine: line + 1,
      endLine: line + insertedLines.length,
      totalLines: countLines(updated),
    };
  }

  /** TextEditorFsCallbacks.patch — line-bounded hunks, applied descending. */
  patch(
    path: string,
    hunks: Array<{
      startLine: number;
      endLine: number;
      replacement: string;
      expectedOriginal?: string | undefined;
    }>,
  ): EditResult {
    const content = this.requireFile(path);
    const lines = content.split('\n');
    // Resolve each hunk's actual line range BEFORE applying. When a hunk carries
    // `expectedOriginal`, that text is the ground truth and the line range is only
    // a hint — and the dominant edit failure is a stale hint: a prior edit shifted
    // the file so [startLine-endLine] no longer points at the intended text. If the
    // expectedOriginal text still exists UNIQUELY elsewhere, relocate the hunk to
    // where it actually is (semantics are preserved — we replace exactly the text
    // the model named). 0 occurrences = genuinely gone; >1 = ambiguous → error.
    const resolved = hunks.map((h) => {
      // Only relocate by a MEANINGFUL anchor. A whitespace-only/empty
      // expectedOriginal carries no signal and could relocate onto an unintended
      // blank line — fall through to the range path (and its checks) instead.
      if (h.expectedOriginal === undefined || h.expectedOriginal.trim() === '') return h;
      const inRange = h.startLine >= 1 && h.endLine <= lines.length && h.endLine >= h.startLine;
      const atRange = inRange ? lines.slice(h.startLine - 1, h.endLine).join('\n') : null;
      if (atRange === h.expectedOriginal) return h; // range still correct — fast path
      const block = h.expectedOriginal.split('\n');
      const hits = findContiguousBlock(lines, block);
      if (hits.length === 1) {
        const start = (hits[0] as number) + 1;
        return { ...h, startLine: start, endLine: start + block.length - 1 };
      }
      const reason =
        hits.length === 0
          ? `and that exact text is not present anywhere in the file (it now has ${lines.length} lines) — it may have been edited already. Recover: \`view\` ${path}, copy the CURRENT snippet, then re-issue (or \`create\` to rewrite the file).`
          : `and it appears ${hits.length} times, so the target is ambiguous — add more surrounding context to expectedOriginal to make it unique.`;
      throw new PlayforgeError(
        `patch: expectedOriginal at [${h.startLine}-${h.endLine}] in ${path} does not match the file's current content there ${reason}`,
        ERROR_CODES.IPC_BAD_INPUT,
      );
    });
    const ordered = [...resolved].sort((a, b) => b.startLine - a.startLine);
    for (let i = 0; i < ordered.length; i++) {
      const h = ordered[i];
      if (!h) continue;
      // Reject (never coerce) non-integer line numbers: slice() truncates toward
      // zero while splice()'s deleteCount truncates independently, so a fractional
      // range that PASSED the expectedOriginal/range check above could delete a
      // different line count than it verified — silent corruption. (Review #3.)
      if (!Number.isInteger(h.startLine) || !Number.isInteger(h.endLine)) {
        throw new PlayforgeError(
          `patch: hunk line numbers must be integers, got [${h.startLine}-${h.endLine}] in ${path}`,
          ERROR_CODES.IPC_BAD_INPUT,
        );
      }
      if (h.startLine < 1 || h.endLine > lines.length || h.endLine < h.startLine) {
        throw new PlayforgeError(
          `patch: hunk [${h.startLine}-${h.endLine}] out of range in ${path}`,
          ERROR_CODES.IPC_BAD_INPUT,
        );
      }
      const prev = ordered[i - 1];
      if (prev && h.endLine >= prev.startLine) {
        throw new PlayforgeError(`patch: overlapping hunks in ${path}`, ERROR_CODES.IPC_BAD_INPUT);
      }
      lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, ...h.replacement.split('\n'));
    }
    const updated = lines.join('\n');
    this.files.set(path, updated);
    return { path, totalLines: countLines(updated) };
  }

  /** TextEditorFsCallbacks.listDir — sorted paths under `dir` (''/'.' = root). */
  listDir(dir: string): string[] {
    const prefix = dir === '' || dir === '.' || dir === '/' ? '' : `${dir.replace(/\/$/, '')}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  /** Current file count. */
  get size(): number {
    return this.files.size;
  }

  /** Snapshot-store input for the current tree. Text files are UTF-8 encoded;
   *  base64 data-URL asset sentinels are decoded back to their real bytes. */
  toSnapshotInput(): SnapshotInputFile[] {
    return [...this.files.entries()].map(([path, content]) => ({
      path,
      bytes: decodeMaybeDataUrl(content),
    }));
  }

  /** Current text files, preserving source content for validation passes. */
  toTextFiles(): Array<{ path: string; content: string }> {
    return [...this.files.entries()].map(([path, content]) => ({ path, content }));
  }

  /** Persist the current tree to the content-addressed store. */
  async persist(store: SnapshotStore): Promise<WriteResult> {
    return store.write(this.toSnapshotInput());
  }

  private requireFile(path: string): string {
    // Self-enforce the class's documented containment invariant rather than
    // trusting every caller: strReplace/insert/patch all flow through here, so
    // an unsafe path is rejected before any mutation regardless of how it was
    // supplied. (path-traversal defense-in-depth)
    assertSafeBundlePath(path);
    const content = this.files.get(path);
    if (content === undefined) {
      throw new PlayforgeError(`file not found: ${path}`, ERROR_CODES.IPC_NOT_FOUND);
    }
    return content;
  }
}
