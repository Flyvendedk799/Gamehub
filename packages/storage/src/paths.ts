/**
 * In-bundle file-path validation — the security invariant ported from the
 * desktop base's `design_files` rule. Game file trees come from an untrusted
 * AI agent (and from remixed projects), so every path written to a manifest or
 * served from the games origin must be a safe, POSIX-relative path:
 *   - no leading slash (not absolute)
 *   - no `..` segment (no traversal out of the bundle root)
 *   - no NUL / backslash / drive-letter / protocol
 *   - no C0 control chars (0x00-0x1F) or DEL (0x7F)
 *   - Unicode NFC-normalized (reject decomposed/look-alike forms)
 *   - non-empty, normalized segments
 */
import { ERROR_CODES, PlayforgeError } from '@playforge/shared';

// Any C0 control char (0x00-0x1F) or DEL (0x7F). NUL is a subset but it's also
// checked explicitly below for clarity. Catches CR/LF/TAB/etc. used to smuggle
// paths past line-oriented parsers.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

export function isSafeBundlePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.length > 1024) return false;
  // Reject any path that is not Unicode NFC-normalized. We *reject* rather than
  // silently normalize so the manifest key and the bytes on the wire stay
  // byte-identical to what the caller asserted (no surprise key drift), and so
  // visually-equivalent decomposed forms can't shadow an existing entry.
  if (path.normalize('NFC') !== path) return false;
  if (CONTROL_CHARS_RE.test(path)) return false; // C0 controls (incl. NUL) + DEL
  if (path.startsWith('/') || path.startsWith('\\')) return false; // absolute / UNC
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
    throw new PlayforgeError(
      `Unsafe bundle path rejected: ${JSON.stringify(path)}`,
      ERROR_CODES.IPC_BAD_INPUT,
    );
  }
  return path;
}
