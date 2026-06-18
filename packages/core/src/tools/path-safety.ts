/**
 * Tool-layer path-traversal guard (defense-in-depth).
 *
 * The virtual-FS storage layer already validates and confines paths, but the
 * file tools (text_editor, list_files) are the surface the *model* drives with
 * attacker-influenced strings (prompt-injected filenames, remix-imported
 * content). We reject obviously-hostile paths HERE, before any fs callback is
 * invoked, so a storage-layer bug can never become a traversal: two independent
 * checks must both fail to escape the design root.
 *
 * Rejected shapes (all design paths are root-relative POSIX):
 *   - empty / whitespace-only
 *   - POSIX-absolute (leading "/")
 *   - Windows-absolute / drive-letter ("C:\\…", "\\…")
 *   - any ".." path segment (parent traversal)
 *   - "~" home expansion
 *   - control characters (NUL/DEL & friends — used to truncate/confuse paths)
 *   - backslashes (not valid in our POSIX virtual FS; normalises traversal away)
 */

/** Split on BOTH separators so a `..` hidden behind a backslash is still caught
 *  even though backslashes are independently rejected below. */
function segments(path: string): string[] {
  return path.split(/[/\\]/);
}

/** True if the string contains an ASCII control character (0x00-0x1F or 0x7F).
 *  Checked by char code so no literal control bytes need to live in source. */
function hasControlChar(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Throw if `path` is not a safe root-relative design path. The thrown message
 * is surfaced to the model as the tool result, so it names the offending input
 * and the rule it broke (the model can then re-issue a corrected path).
 */
export function assertSafeToolPath(path: string, toolName: string): void {
  if (path.length === 0 || path.trim().length === 0) {
    throw new Error(`${toolName} refused: path must be a non-empty, root-relative path.`);
  }

  // Control characters (incl. NUL) — never legitimate in a filename and a
  // classic way to truncate or smuggle a path past naive validators.
  if (hasControlChar(path)) {
    throw new Error(`${toolName} refused: path contains a control character.`);
  }

  // POSIX-absolute or Windows UNC/backslash-rooted.
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(
      `${toolName} refused: absolute paths are not allowed ("${path}"). Use a path relative to the design root, e.g. "index.html".`,
    );
  }

  // Windows drive-letter absolute, e.g. C:\ or C:/.
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(
      `${toolName} refused: drive-letter absolute paths are not allowed ("${path}"). Use a root-relative path.`,
    );
  }

  // Backslashes are not valid in our POSIX virtual FS and would let a `..`
  // sneak past a forward-slash-only segment check.
  if (path.includes('\\')) {
    throw new Error(
      `${toolName} refused: backslashes are not allowed in design paths ("${path}"). Use "/" separators.`,
    );
  }

  // Home expansion.
  if (path === '~' || path.startsWith('~/')) {
    throw new Error(`${toolName} refused: home-relative paths ("~") are not allowed ("${path}").`);
  }

  // Reject non-NFC (decomposed / look-alike) forms. The storage layer rejects
  // these too; aligning here means the model gets the rejection at the tool call
  // instead of a surprising late failure when the whole snapshot aborts at
  // persist time. (path-traversal divergence fix)
  if (path.normalize('NFC') !== path) {
    throw new Error(`${toolName} refused: path must be Unicode NFC-normalized ("${path}").`);
  }

  // Any parent-traversal ("..") or bare current-dir (".") segment, and empty
  // segments (leading/trailing/double slash). Mirrors the storage guard's
  // per-segment rule so the two layers accept exactly the same set.
  for (const seg of segments(path)) {
    if (seg === '..') {
      throw new Error(
        `${toolName} refused: parent-directory traversal (".." segment) is not allowed ("${path}").`,
      );
    }
    if (seg === '.') {
      throw new Error(
        `${toolName} refused: "." path segments are not allowed ("${path}"). Use a clean root-relative path.`,
      );
    }
    if (seg === '') {
      throw new Error(
        `${toolName} refused: empty path segment (leading/trailing/double slash) is not allowed ("${path}").`,
      );
    }
  }
}
