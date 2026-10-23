/**
 * SEARCH/REPLACE edit blocks for the host's change-request step.
 *
 * Why: asking the model to return every changed file COMPLETE makes a small change cost as many
 * output tokens as the whole file, and a "combat upgrade" across three files took about four and
 * a half silent minutes on a high-reasoning model. A hunk that names the lines it replaces costs
 * only the lines that change, and it cannot silently drop code it never mentioned.
 *
 *   === EDIT: src/combat.js ===
 *   <<<<<<< SEARCH
 *   exact lines that exist today
 *   =======
 *   the lines that replace them
 *   >>>>>>> REPLACE
 *   === END EDIT ===
 *
 * Applying is strict and reports exactly what did not match, so a retry can be told. A match that
 * differs from the file only in indentation or trailing whitespace is accepted, because that is
 * the one mistake models make constantly and it is never ambiguous.
 */

export interface EditHunk {
  search: string;
  replace: string;
}

export interface EditBlock {
  path: string;
  hunks: EditHunk[];
}

export interface ApplyResult {
  content: string;
  /** One message per hunk that could not be applied; empty when every hunk landed. */
  errors: string[];
}

const EDIT_RE = /^=== EDIT: (\S+?) ===\r?\n([\s\S]*?)\r?\n=== END EDIT ===/gm;
const HUNK_RE = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;
const SUMMARY_RE = /=== SUMMARY ===\r?\n([\s\S]*?)\r?\n=== END SUMMARY ===/;

export function parseEditBlocks(reply: string): EditBlock[] {
  const out: EditBlock[] = [];
  for (const m of reply.matchAll(EDIT_RE)) {
    const path = m[1];
    const body = m[2];
    if (path === undefined || body === undefined) continue;
    const hunks: EditHunk[] = [];
    for (const h of body.matchAll(HUNK_RE)) {
      hunks.push({ search: h[1] ?? '', replace: h[2] ?? '' });
    }
    if (hunks.length > 0) out.push({ path, hunks });
  }
  return out;
}

/** The plain-language summary the model wrote for the player, or null. */
export function parseSummary(reply: string): string | null {
  const text = SUMMARY_RE.exec(reply)?.[1]?.trim();
  return text !== undefined && text.length > 0 ? text : null;
}

/** Index of the first line at which `needle` (trimmed, line by line) occurs in `hay`. */
function findTrimmedWindow(hay: string[], needle: string[]): number[] {
  const hits: number[] = [];
  const want = needle.map((l) => l.trim());
  for (let i = 0; i + want.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if ((hay[i + j] ?? '').trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

function describe(search: string): string {
  const first = search.split('\n').find((l) => l.trim().length > 0) ?? '';
  return `"${first.trim().slice(0, 70)}"`;
}

/** Apply hunks in order to `original`. Never throws; failures come back in `errors`. */
export function applyHunks(original: string, hunks: readonly EditHunk[]): ApplyResult {
  let content = original;
  const errors: string[] = [];
  hunks.forEach((hunk, index) => {
    const label = `hunk ${index + 1} (${describe(hunk.search)})`;
    if (hunk.search.trim().length === 0) {
      errors.push(`${label}: the SEARCH part is empty, so there is nothing to locate.`);
      return;
    }
    const first = content.indexOf(hunk.search);
    if (first !== -1) {
      if (content.indexOf(hunk.search, first + 1) !== -1) {
        errors.push(
          `${label}: that SEARCH text appears more than once. Include a few more surrounding lines so it is unique.`,
        );
        return;
      }
      content = content.slice(0, first) + hunk.replace + content.slice(first + hunk.search.length);
      return;
    }
    // Same lines, different indentation / trailing whitespace.
    const hay = content.split('\n');
    const hits = findTrimmedWindow(hay, hunk.search.split('\n'));
    if (hits.length === 1) {
      const at = hits[0] as number;
      const span = hunk.search.split('\n').length;
      content = [...hay.slice(0, at), ...hunk.replace.split('\n'), ...hay.slice(at + span)].join(
        '\n',
      );
      return;
    }
    errors.push(
      hits.length > 1
        ? `${label}: that SEARCH text appears more than once. Include a few more surrounding lines so it is unique.`
        : `${label}: that SEARCH text is not in the file. Copy the lines EXACTLY as they appear in the file shown above.`,
    );
  });
  return { content, errors };
}
