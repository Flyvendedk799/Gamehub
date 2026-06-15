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
import { CodesignError, ERROR_CODES } from '@playforge/shared';
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

  /** TextEditorFsCallbacks.strReplace — oldStr must occur exactly once. */
  strReplace(path: string, oldStr: string, newStr: string): EditResult {
    const content = this.requireFile(path);
    const first = content.indexOf(oldStr);
    if (first === -1) {
      throw new CodesignError(
        `str_replace: no match for the given text in ${path}`,
        ERROR_CODES.IPC_BAD_INPUT,
      );
    }
    if (content.indexOf(oldStr, first + 1) !== -1) {
      throw new CodesignError(
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
      throw new CodesignError(
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
    const ordered = [...hunks].sort((a, b) => b.startLine - a.startLine);
    for (let i = 0; i < ordered.length; i++) {
      const h = ordered[i];
      if (!h) continue;
      if (h.startLine < 1 || h.endLine > lines.length || h.endLine < h.startLine) {
        throw new CodesignError(
          `patch: hunk [${h.startLine}-${h.endLine}] out of range in ${path}`,
          ERROR_CODES.IPC_BAD_INPUT,
        );
      }
      const prev = ordered[i - 1];
      if (prev && h.endLine >= prev.startLine) {
        throw new CodesignError(`patch: overlapping hunks in ${path}`, ERROR_CODES.IPC_BAD_INPUT);
      }
      const original = lines.slice(h.startLine - 1, h.endLine).join('\n');
      if (h.expectedOriginal !== undefined && h.expectedOriginal !== original) {
        throw new CodesignError(
          `patch: expectedOriginal mismatch at [${h.startLine}-${h.endLine}] in ${path}`,
          ERROR_CODES.IPC_BAD_INPUT,
        );
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

  /** Snapshot-store input for the current tree (UTF-8 encoded). */
  toSnapshotInput(): SnapshotInputFile[] {
    return [...this.files.entries()].map(([path, content]) => ({
      path,
      bytes: new TextEncoder().encode(content),
    }));
  }

  /** Persist the current tree to the content-addressed store. */
  async persist(store: SnapshotStore): Promise<WriteResult> {
    return store.write(this.toSnapshotInput());
  }

  private requireFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new CodesignError(`file not found: ${path}`, ERROR_CODES.IPC_NOT_FOUND);
    }
    return content;
  }
}
