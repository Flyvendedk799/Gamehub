import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Resolves a safe file path confined within projectRoot.
 * Strictly prevents sibling directory prefix-overlap escape (CWE-22) and null-byte poisoning.
 */
export function resolveSafePath(projectRoot: string, userPath: string): string {
  if (userPath.includes('\0')) {
    throw new Error(
      `Security Violation: Path traversal outside project root is forbidden (${userPath})`,
    );
  }
  const base = path.resolve(projectRoot);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  const resolved = path.resolve(base, userPath);
  if ((resolved !== base && !resolved.startsWith(baseWithSep)) || resolved.includes('\0')) {
    throw new Error(
      `Security Violation: Path traversal outside project root is forbidden (${userPath})`,
    );
  }
  return resolved;
}

/**
 * Atomically writes content to filePath by writing to a temporary file
 * and renaming it to the target file.
 */
export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Forward-compatible Zod tool schemas configured with .passthrough()
 */
export const TextEditorToolSchema = z
  .object({
    command: z.enum(['create', 'str_replace', 'insert', 'patch', 'view', 'undo']),
    path: z.string(),
    file_text: z.string().optional(),
    old_str: z.string().optional(),
    new_str: z.string().optional(),
    insert_line: z.number().optional(),
    view_range: z.tuple([z.number(), z.number()]).optional(),
  })
  .passthrough();

export const SetTodosToolSchema = z
  .object({
    todos: z.array(
      z
        .object({
          id: z.string().optional(),
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const DoneToolSchema = z
  .object({
    status: z.enum(['completed', 'has_errors']).optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export const ReadUrlToolSchema = z
  .object({
    url: z.string(),
  })
  .passthrough();

export const ListFilesToolSchema = z
  .object({
    path: z.string().optional(),
  })
  .passthrough();

export function createToolSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).passthrough();
}
