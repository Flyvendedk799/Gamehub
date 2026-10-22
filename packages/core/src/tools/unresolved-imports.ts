/**
 * Static check for ES-module imports that cannot resolve.
 *
 * A model that rewrites one module often drops an export another module still imports. The
 * browser then refuses to run the whole graph with a message like
 *   "The requested module 'data:text/javascript;base64,…' does not provide an export named 'FOG'"
 * which names neither the importing file nor the file that should have exported it. This finds the
 * same problem before the browser does and says exactly which import is broken and where to fix it.
 *
 * Deliberately conservative: it only reports when it is SURE (a relative import of a file in the
 * project whose exports it fully understands). Anything it cannot reason about — `export *`,
 * computed exports, a target outside the project — is skipped rather than guessed at.
 */

export interface ProjectFile {
  path: string;
  content: string;
}

export interface UnresolvedImport {
  /** The importing file. */
  from: string;
  /** The file that was imported (resolved project path). */
  target: string;
  /** Names the importer asked for that the target does not export. */
  missing: string[];
  /** The specifier as written, e.g. '../theme.js'. */
  specifier: string;
}

const IMPORT_RE = /(^|[\n;])\s*import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function resolveRelative(fromPath: string, specifier: string): string {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of specifier.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Names a module exports, or null when it cannot be known statically. */
export function exportedNames(source: string): Set<string> | null {
  const src = stripComments(source);
  if (/\bexport\s*\*\s*(as\s+\w+\s*)?from\b/.test(src)) return null;
  const names = new Set<string>();
  for (const m of src.matchAll(
    /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(piece);
      names.add(alias?.[1] ?? piece.split(/\s+/)[0] ?? piece);
    }
  }
  if (/\bexport\s+default\b/.test(src)) names.add('default');
  return names;
}

/** Names an import clause asks for (`{ a, b as c }`, default). Namespace imports ask for none. */
function requestedNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of (braces[1] ?? '').split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const original = piece.split(/\s+as\s+/)[0]?.trim();
      if (original) names.push(original);
    }
  }
  const outside = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '');
  if (/^\s*[A-Za-z_$][\w$]*\s*,?\s*$/.test(outside)) names.push('default');
  return names;
}

export function findUnresolvedImports(files: ProjectFile[]): UnresolvedImport[] {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const exportCache = new Map<string, Set<string> | null>();
  const problems: UnresolvedImport[] = [];
  for (const file of files) {
    if (!/\.(m?js)$/.test(file.path)) continue;
    const src = stripComments(file.content);
    for (const m of src.matchAll(IMPORT_RE)) {
      const clause = m[2] ?? '';
      const specifier = m[3] ?? '';
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const target = resolveRelative(file.path, specifier);
      const targetSource = byPath.get(target);
      if (targetSource === undefined) continue;
      let exported = exportCache.get(target);
      if (exported === undefined) {
        exported = exportedNames(targetSource);
        exportCache.set(target, exported);
      }
      if (exported === null) continue;
      const missing = requestedNames(clause).filter((name) => !exported?.has(name));
      if (missing.length > 0) problems.push({ from: file.path, target, missing, specifier });
    }
  }
  return problems;
}

export function describeUnresolvedImport(p: UnresolvedImport): string {
  const list = p.missing.map((n) => (n === 'default' ? 'the default export' : n)).join(', ');
  return (
    `${p.from} imports ${list} from '${p.specifier}', but ${p.target} does not export it. ` +
    `Either add the export to ${p.target} (e.g. \`export const ${p.missing[0] === 'default' ? 'value' : p.missing[0]} = …\`) ` +
    `or change the import in ${p.from}. One unresolved import stops the WHOLE game from loading.`
  );
}

/**
 * Files that load `target` — by an ES import / dynamic import / `export … from`, or by an HTML
 * `<script src>` / `<link href>`. Used to refuse deleting a module the game still loads: deleting
 * one is not recoverable inside a run, and a single dangling reference stops the WHOLE game.
 */
export function filesReferencing(files: ProjectFile[], target: string): string[] {
  const referrers: string[] = [];
  for (const file of files) {
    if (file.path === target) continue;
    const isHtml = /\.html?$/i.test(file.path);
    if (!isHtml && !/\.(m?js|cjs|jsx|tsx?)$/i.test(file.path)) continue;
    const text = isHtml ? file.content : stripComments(file.content);
    for (const m of text.matchAll(/['"]([^'"\s]+\.(?:m?js|cjs|jsx|tsx?|css|json))['"]/g)) {
      const token = m[1] ?? '';
      let resolved: string | null = null;
      if (token.startsWith('./') || token.startsWith('../')) {
        resolved = resolveRelative(file.path, token);
      } else if (token.startsWith('/')) {
        resolved = token.replace(/^\/+/, '');
      } else if (isHtml && !/^[a-z][a-z0-9+.-]*:/i.test(token)) {
        resolved = resolveRelative(file.path, token);
      }
      if (resolved === target) {
        referrers.push(file.path);
        break;
      }
    }
  }
  return referrers;
}
