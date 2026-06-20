/**
 * Dependency-free syntax highlighter for the read-only code viewer in the Files
 * tab. The product runs untrusted, AI-generated game source, so SECURITY is the
 * first concern: every code path HTML-escapes the raw text BEFORE wrapping any
 * token in a <span>. The output is consumed via dangerouslySetInnerHTML, so it
 * must never emit unescaped user text.
 *
 * Token CSS: the colors for the `tok-*` classes are exported as a constant CSS
 * string (CODE_HIGHLIGHT_CSS) which FilesPanel injects once via a <style> tag.
 * This keeps the highlighter self-contained (no Tailwind class coupling, no
 * global stylesheet edit) and guarantees the colors apply wherever the HTML is
 * rendered.
 */

export type HiLang = 'html' | 'css' | 'js' | 'json' | 'plain';

/** Map a file path to the highlighter language. */
export function langFromPath(path: string): HiLang {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'tsx':
    case 'jsx':
      return 'js';
    case 'json':
      return 'json';
    default:
      return 'plain';
  }
}

/** Escape the five characters that matter for safe HTML text content. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function span(cls: string, escaped: string): string {
  return `<span class="${cls}">${escaped}</span>`;
}

const JS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'in',
  'of',
  'class',
  'extends',
  'super',
  'import',
  'export',
  'from',
  'as',
  'await',
  'async',
  'yield',
  'try',
  'catch',
  'finally',
  'throw',
  'this',
  'void',
  'with',
  'true',
  'false',
  'null',
  'undefined',
  'static',
  'get',
  'set',
]);

/**
 * Tokenize already-source text into highlighted, HTML-escaped HTML. Each branch
 * escapes every captured chunk before emitting it. The general strategy is a
 * single ordered regex with named-ish alternatives; the first matching group
 * wins, and any text between matches is escaped as plain.
 */
function highlightJs(code: string): string {
  // Order matters: comments + strings first (they may contain keyword-looking
  // text), then numbers, then identifiers (checked against the keyword set).
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|([{}()[\];,.:?=+\-*/%<>!&|^~]+)/g;
  return tokenize(code, re, (m) => {
    if (m[1] !== undefined) return span('tok-comment', escapeHtml(m[1]));
    if (m[2] !== undefined) return span('tok-string', escapeHtml(m[2]));
    if (m[3] !== undefined) return span('tok-number', escapeHtml(m[3]));
    if (m[4] !== undefined) {
      return JS_KEYWORDS.has(m[4]) ? span('tok-keyword', escapeHtml(m[4])) : escapeHtml(m[4]);
    }
    if (m[5] !== undefined) return span('tok-punct', escapeHtml(m[5]));
    return escapeHtml(m[0]);
  });
}

function highlightJson(code: string): string {
  const re =
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(\b(?:true|false|null)\b)|(-?\b\d[\d]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}[\],:])/g;
  return tokenize(code, re, (m) => {
    if (m[1] !== undefined) {
      // A key (string followed by colon): split the colon punctuation out.
      const colonIdx = m[1].lastIndexOf(':');
      const key = m[1].slice(0, colonIdx);
      const rest = m[1].slice(colonIdx);
      return span('tok-attr', escapeHtml(key)) + span('tok-punct', escapeHtml(rest));
    }
    if (m[2] !== undefined) return span('tok-string', escapeHtml(m[2]));
    if (m[3] !== undefined) return span('tok-keyword', escapeHtml(m[3]));
    if (m[4] !== undefined) return span('tok-number', escapeHtml(m[4]));
    if (m[5] !== undefined) return span('tok-punct', escapeHtml(m[5]));
    return escapeHtml(m[0]);
  });
}

function highlightCss(code: string): string {
  // Comments, strings, at-rules/property names, numbers (with units), then the
  // structural punctuation. Selectors fall through as plain text — keeping the
  // tokenizer simple and robust rather than perfectly selector-aware.
  const re =
    /(\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(#[0-9a-fA-F]{3,8}\b)|(\b-?\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b)|([\w-]+\s*(?=:))|([{}();:,])/g;
  return tokenize(code, re, (m) => {
    if (m[1] !== undefined) return span('tok-comment', escapeHtml(m[1]));
    if (m[2] !== undefined) return span('tok-string', escapeHtml(m[2]));
    if (m[3] !== undefined) return span('tok-number', escapeHtml(m[3]));
    if (m[4] !== undefined) return span('tok-number', escapeHtml(m[4]));
    if (m[5] !== undefined) return span('tok-attr', escapeHtml(m[5]));
    if (m[6] !== undefined) return span('tok-punct', escapeHtml(m[6]));
    return escapeHtml(m[0]);
  });
}

function highlightHtml(code: string): string {
  // Comments and full tags. Inside a tag we further tokenize the name, attribute
  // names, attribute values, and angle brackets. Text nodes are escaped plain.
  const re = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][^>]*?>|<[A-Za-z][^>]*?>)/g;
  return tokenize(code, re, (m) => {
    if (m[1] !== undefined) return span('tok-comment', escapeHtml(m[1]));
    if (m[2] !== undefined) return highlightHtmlTag(m[2]);
    return escapeHtml(m[0]);
  });
}

function highlightHtmlTag(tag: string): string {
  // Sub-tokenize within a single tag: < / tagname attr="val" >
  const re =
    /(<\/?)|([A-Za-z][A-Za-z0-9-]*)(?==|\s|\/?>)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/?>)|([=\s]+)/g;
  let out = '';
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let sawTagName = false;
  // The first identifier after `<`/`</` is the tag name; later identifiers are
  // attribute names.
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(tag)) !== null) {
    if (m.index > lastIndex) out += escapeHtml(tag.slice(lastIndex, m.index));
    if (m[1] !== undefined) {
      out += span('tok-punct', escapeHtml(m[1]));
    } else if (m[2] !== undefined) {
      out += sawTagName ? span('tok-attr', escapeHtml(m[2])) : span('tok-tag', escapeHtml(m[2]));
      sawTagName = true;
    } else if (m[3] !== undefined) {
      out += span('tok-string', escapeHtml(m[3]));
    } else if (m[4] !== undefined) {
      out += span('tok-punct', escapeHtml(m[4]));
    } else if (m[5] !== undefined) {
      out += escapeHtml(m[5]);
    } else {
      out += escapeHtml(m[0]);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < tag.length) out += escapeHtml(tag.slice(lastIndex));
  return out;
}

/**
 * Run an ordered regex over `code`, escaping the gaps between matches as plain
 * text and handing each match to `render`. Guarantees every character of the
 * input is emitted exactly once, escaped.
 */
function tokenize(code: string, re: RegExp, render: (m: RegExpExecArray) => string): string {
  let out = '';
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(code)) !== null) {
    if (m.index > lastIndex) out += escapeHtml(code.slice(lastIndex, m.index));
    // Guard against zero-width matches causing an infinite loop.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out += render(m);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < code.length) out += escapeHtml(code.slice(lastIndex));
  return out;
}

/**
 * Highlight `code` for `lang` and return SAFE, HTML-escaped markup with token
 * spans. For 'plain', returns only the escaped text (no spans).
 */
export function highlightToHtml(code: string, lang: HiLang): string {
  switch (lang) {
    case 'js':
      return highlightJs(code);
    case 'json':
      return highlightJson(code);
    case 'css':
      return highlightCss(code);
    case 'html':
      return highlightHtml(code);
    default:
      return escapeHtml(code);
  }
}

/** Token color CSS for the dark theme. Injected once by FilesPanel. */
export const CODE_HIGHLIGHT_CSS = `
.pf-code { color: #d4d4d8; }
.pf-code .tok-comment { color: #5c6370; font-style: italic; }
.pf-code .tok-string { color: #98c379; }
.pf-code .tok-keyword { color: #c678dd; }
.pf-code .tok-number { color: #d19a66; }
.pf-code .tok-tag { color: #e06c75; }
.pf-code .tok-attr { color: #d19a66; }
.pf-code .tok-punct { color: #abb2bf; }
`;
