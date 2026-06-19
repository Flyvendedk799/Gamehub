import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const JAVASCRIPT_PATH_RE = /\.(?:cjs|js|mjs)$/i;
const CHECK_TIMEOUT_MS = 5_000;
const CHECK_MAX_BUFFER = 128 * 1024;

export interface GeneratedJavaScriptSyntaxIssue {
  path: string;
  detail: string;
}

function tempExtension(path: string): '.cjs' | '.mjs' {
  return path.toLowerCase().endsWith('.cjs') ? '.cjs' : '.mjs';
}

function errorText(err: unknown): string {
  const fields = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof fields.stderr === 'string' ? fields.stderr : '';
  const stdout = typeof fields.stdout === 'string' ? fields.stdout : '';
  const message = typeof fields.message === 'string' ? fields.message : '';
  return [stderr, stdout, message]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trim();
}

function mapTempPath(detail: string, tempFile: string, sourcePath: string): string {
  return detail.split(tempFile).join(sourcePath);
}

export async function checkGeneratedJavaScriptSyntax(
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<GeneratedJavaScriptSyntaxIssue[]> {
  const jsFiles = files.filter((file) => JAVASCRIPT_PATH_RE.test(file.path));
  if (jsFiles.length === 0) return [];

  const tempDir = await mkdtemp(join(tmpdir(), 'playforge-js-check-'));
  try {
    const issues: GeneratedJavaScriptSyntaxIssue[] = [];
    for (let i = 0; i < jsFiles.length; i++) {
      const file = jsFiles[i]!;
      const tempFile = join(tempDir, `module-${i}${tempExtension(file.path)}`);
      await writeFile(tempFile, file.content, 'utf8');
      try {
        await execFileAsync(process.execPath, ['--check', tempFile], {
          timeout: CHECK_TIMEOUT_MS,
          maxBuffer: CHECK_MAX_BUFFER,
        });
      } catch (err) {
        const detail = mapTempPath(errorText(err), tempFile, file.path);
        issues.push({
          path: file.path,
          detail: detail || `Generated JavaScript syntax check failed in ${file.path}.`,
        });
      }
    }
    return issues;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function assertGeneratedJavaScriptSyntax(
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  const issues = await checkGeneratedJavaScriptSyntax(files);
  if (issues.length === 0) return;

  throw new Error(
    [
      'Generated JavaScript syntax check failed.',
      ...issues.map((issue) => `${issue.path}:\n${issue.detail}`),
    ].join('\n\n'),
  );
}
