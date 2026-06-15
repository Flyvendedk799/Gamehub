/**
 * In-bundle file-path validation — the security invariant ported from the
 * desktop base's `design_files` rule. Game file trees come from an untrusted
 * AI agent (and from remixed projects), so every path written to a manifest or
 * served from the games origin must be a safe, POSIX-relative path:
 *   - no leading slash (not absolute)
 *   - no `..` segment (no traversal out of the bundle root)
 *   - no NUL / backslash / drive-letter / protocol
 *   - non-empty, normalized segments
 */
import { CodesignError, ERROR_CODES } from '@playforge/shared';

export function isSafeBundlePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.length > 1024) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (path.includes('\\')) return false;
  if (path.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false; // windows drive
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return false; // protocol://
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Throws a typed error if the path is unsafe; returns it unchanged otherwise. */
export function assertSafeBundlePath(path: string): string {
  if (!isSafeBundlePath(path)) {
    throw new CodesignError(
      `Unsafe bundle path rejected: ${JSON.stringify(path)}`,
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  return path;
}
