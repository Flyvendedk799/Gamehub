/**
 * Refuse a replacement that turns the rest of a code line into a comment.
 *
 * Run 8db3aa61: a repair agent asked to make the playtest pass replaced the single token
 * `opponentHp` with a block comment and then with `// playtest fix`, which turned
 * `  opponentHp: () => enemy.hp,` into `  // playtest fix: () => enemy.hp,`. The game's debug
 * snapshot lost the field the playtest reads, the run failed on its own damage, and nothing
 * stopped the edit because the file still parsed.
 *
 * A `//` that was not there before, landing in front of code that was, is almost never what the
 * author meant. (A comment appended at the END of a line, or a whole new comment line, is fine.)
 */

/** Returns a refusal message, or null when the replacement does not swallow code. */
export function commentSwallowRefusal(
  content: string,
  oldStr: string,
  newStr: string,
): string | null {
  if (!newStr.includes('//') || oldStr.includes('//')) return null;
  const at = content.indexOf(oldStr);
  if (at === -1) return null;
  const lineEnd = content.indexOf('\n', at + oldStr.length);
  const tail = content.slice(at + oldStr.length, lineEnd === -1 ? undefined : lineEnd);
  // Where the new text opens a line comment, everything after it on the line is now commented out.
  const commentStart = newStr.indexOf('//');
  const afterComment = newStr.slice(commentStart).split('\n')[0] ?? '';
  const commentRunsToEndOfNewStr = !newStr.slice(commentStart).includes('\n');
  if (!commentRunsToEndOfNewStr) return null;
  const swallowed = `${afterComment.slice(2)}${tail}`.trim();
  if (tail.trim().length === 0) return null; // nothing after it on this line
  return `Refusing str_replace: your new_str opens a \`//\` comment in front of code that is still on the same line (\`${tail.trim().slice(0, 60)}\`), so that code would stop running (\`${swallowed.slice(0, 60)}\`). Replace the whole statement, or put the comment on its own line. Do not comment out a value to make a check pass.`;
}
