/**
 * list_files — show the agent the contents of its virtual FS so it can
 * decide what to view/edit next without guessing at filenames.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { assertSafeToolPath } from './path-safety.js';
import type { TextEditorFsCallbacks } from './text-editor.js';

const ListFilesParams = Type.Object({
  dir: Type.Optional(Type.String()),
});

export interface ListFilesDetails {
  dir: string;
  entries: string[];
}

export function makeListFilesTool(
  fs: TextEditorFsCallbacks,
): AgentTool<typeof ListFilesParams, ListFilesDetails> {
  return {
    name: 'list_files',
    label: 'List files',
    description:
      'List files in the design virtual filesystem. Pass an optional `dir` ' +
      '(defaults to the design root). Returns one filename per line, sorted.',
    parameters: ListFilesParams,
    async execute(_id, params): Promise<AgentToolResult<ListFilesDetails>> {
      const rawDir = params.dir ?? '';
      // Tool-layer path-traversal assertion (defense-in-depth). The default
      // (root) listing passes an empty/whitespace dir, which is legitimate;
      // only validate an explicitly-supplied dir BEFORE touching the fs.
      if (rawDir.trim().length > 0) {
        assertSafeToolPath(rawDir, 'list_files');
      }
      const dir = rawDir.replace(/^\/+|\/+$/g, '');
      const entries = fs.listDir(dir);
      const text = entries.length === 0 ? '(empty)' : entries.join('\n');
      return { content: [{ type: 'text', text }], details: { dir, entries } };
    },
  };
}
