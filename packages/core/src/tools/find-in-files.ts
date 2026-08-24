/**
 * Literal search across the working tree.
 *
 * The gap this closes: the edit tool could read a file by line range or by
 * top-level symbol name, and nothing else. Neither answers "where is this
 * string / config value / call site", so agents located things by scanning —
 * one round trip per window, about ten seconds each. Two production runs made
 * 96 range views against a single 745-line file doing work that a handful of
 * searches would have answered outright.
 *
 * Literal rather than regex, deliberately. A literal cannot misfire on a stray
 * bracket or quote in generated game code, the agent is nearly always looking
 * for a name it has already seen, and a malformed pattern costs another round
 * trip to discover — which is the exact cost this exists to remove.
 */

export interface FindFile {
  readonly path: string;
  readonly content: string;
}

/** Hits returned in one call. Past this, the query is too broad to be useful. */
export const FIND_HIT_CAP = 40;

/** Context lines allowed either side of a hit. */
export const FIND_MAX_CONTEXT = 12;

function renderHit(path: string, lines: readonly string[], index: number, context: number): string {
  if (context <= 0) {
    return `${path}:${index + 1}: ${(lines[index] ?? '').trim()}`;
  }
  const from = Math.max(0, index - context);
  const to = Math.min(lines.length - 1, index + context);
  const block: string[] = [];
  for (let j = from; j <= to; j += 1) {
    // The matched line is marked so a wide context window stays readable.
    const marker = j === index ? '>' : ' ';
    block.push(`${marker} ${String(j + 1).padStart(4, ' ')}  ${lines[j] ?? ''}`);
  }
  return `${path}:${index + 1}\n${block.join('\n')}`;
}

/**
 * Search `files` for a literal `query`.
 *
 * Returns the rendered result directly — this is tool output, and the phrasing
 * is what steers the agent's next move, so it belongs with the search rather
 * than at the call site.
 */
export function findInFiles(
  files: readonly FindFile[],
  query: string,
  contextLines = 2,
): { text: string; total: number } {
  if (query.length === 0) {
    return { text: 'find: `query` must be a non-empty string.', total: 0 };
  }
  const context = Math.min(Math.max(0, Math.floor(contextLines)), FIND_MAX_CONTEXT);

  const hits: string[] = [];
  let total = 0;

  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!(lines[i] ?? '').includes(query)) continue;
      total += 1;
      if (hits.length < FIND_HIT_CAP) hits.push(renderHit(file.path, lines, i, context));
    }
  }

  const where =
    files.length === 1 ? (files[0]?.path ?? 'the file') : `${files.length} files in the project`;

  if (total === 0) {
    return {
      text: `find: no match for ${JSON.stringify(query)} in ${where}. Try a shorter distinctive fragment — a literal is matched exactly, whitespace included.`,
      total: 0,
    };
  }

  const capped =
    total > hits.length
      ? `\n\n… and ${total - hits.length} more. Narrow the query to see the rest.`
      : '';

  return {
    text: `find: ${total} match(es) for ${JSON.stringify(query)} in ${where}\n\n${hits.join(context > 0 ? '\n\n' : '\n')}${capped}`,
    total,
  };
}
