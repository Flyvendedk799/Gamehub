import { describe, expect, it } from 'vitest';
import { type HiLang, highlightToHtml, langFromPath } from '../syntax-highlight';

/** Strip all <span ...> and </span> tags to recover the escaped text payload. */
function stripSpans(html: string): string {
  return html.replace(/<\/?span[^>]*>/g, '');
}

describe('langFromPath', () => {
  it('maps extensions to languages', () => {
    expect(langFromPath('a.html')).toBe('html');
    expect(langFromPath('a.htm')).toBe('html');
    expect(langFromPath('a.css')).toBe('css');
    expect(langFromPath('a.js')).toBe('js');
    expect(langFromPath('a.ts')).toBe('js');
    expect(langFromPath('a.json')).toBe('json');
    expect(langFromPath('README')).toBe('plain');
    expect(langFromPath('a.txt')).toBe('plain');
  });
});

describe('highlightToHtml — escaping (security)', () => {
  const langs: HiLang[] = ['html', 'css', 'js', 'json', 'plain'];

  it('escapes < > & in every language so no raw markup leaks', () => {
    for (const lang of langs) {
      const out = highlightToHtml('<script>alert("x" & 1)</script>', lang);
      // The only "<" allowed in the output is the opening of our own <span> tags
      // (some languages tokenize the angle brackets into separate spans, which is
      // still safe — the user's "<" is always emitted as the &lt; entity).
      const stripped = stripSpans(out);
      expect(stripped).not.toMatch(/<(?!\/?span)/);
      expect(stripped).not.toContain('<script>');
      expect(stripped).toContain('&lt;');
      expect(stripped).toContain('&gt;');
      expect(stripped).toContain('script');
    }
  });

  it('escapes a literal <script> as a contiguous entity in plain text', () => {
    // Plain text wraps nothing in spans, so the escaped form stays contiguous.
    expect(highlightToHtml('<script>', 'plain')).toBe('&lt;script&gt;');
  });

  it('plain returns escaped-only (no token spans)', () => {
    const out = highlightToHtml('const x = "<b>"', 'plain');
    expect(out).not.toContain('<span');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('&quot;');
  });

  it('escapes a raw ampersand to an entity', () => {
    expect(highlightToHtml('a && b', 'js')).toContain('&amp;&amp;');
  });
});

describe('highlightToHtml — token classes', () => {
  it('marks JS keywords, strings, numbers, and comments', () => {
    const out = highlightToHtml('const n = 42; // hi\nconst s = "hello";', 'js');
    expect(out).toContain('<span class="tok-keyword">const</span>');
    expect(out).toContain('<span class="tok-number">42</span>');
    expect(out).toContain('tok-comment');
    expect(out).toContain('<span class="tok-string">&quot;hello&quot;</span>');
  });

  it('marks HTML tags and attributes', () => {
    const out = highlightToHtml('<div class="x">hi</div>', 'html');
    expect(out).toContain('<span class="tok-tag">div</span>');
    expect(out).toContain('<span class="tok-attr">class</span>');
  });

  it('marks CSS comments and properties', () => {
    const out = highlightToHtml('/* c */\n.a { color: red; }', 'css');
    expect(out).toContain('tok-comment');
    expect(out).toContain('<span class="tok-attr">color</span>');
  });

  it('marks JSON keys, strings, booleans, and numbers', () => {
    const out = highlightToHtml('{ "k": "v", "n": 3, "b": true }', 'json');
    expect(out).toContain('tok-attr');
    expect(out).toContain('<span class="tok-number">3</span>');
    expect(out).toContain('<span class="tok-keyword">true</span>');
  });
});
