/**
 * IMPROVEMENT_BACKLOG #47 + #41 (runtime half) — bootstrap-safety unit tests.
 */

import { describe, expect, it } from 'vitest';
import {
  assertSemver,
  detectNetworkReferences,
  escapeAttribute,
  escapeHtml,
  networkReferenceWarning,
  sanitizeGameBaseUrl,
} from './bootstrap-safety';

describe('escapeHtml / escapeAttribute (#47)', () => {
  it('neutralises angle brackets, quotes, ampersands', () => {
    const raw = `"><script>alert(1)</script>&'`;
    const escaped = escapeHtml(raw);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('">');
    expect(escaped).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;');
  });

  it('escapeAttribute matches escapeHtml', () => {
    const raw = `a"b<c>d&e'f`;
    expect(escapeAttribute(raw)).toBe(escapeHtml(raw));
  });
});

describe('assertSemver (#47)', () => {
  it('accepts strict semvers', () => {
    expect(assertSemver('0.170.0')).toBe('0.170.0');
    expect(assertSemver('3.88.0')).toBe('3.88.0');
    expect(assertSemver('1.2.3-alpha.1')).toBe('1.2.3-alpha.1');
    expect(assertSemver('1.2.3+build.5')).toBe('1.2.3+build.5');
  });

  it('rejects non-semver / injection payloads', () => {
    expect(() => assertSemver('0.170.0"/></script><script>alert(1)</script>')).toThrow();
    expect(() => assertSemver('v1.2.3')).toThrow();
    expect(() => assertSemver('1.2')).toThrow();
    expect(() => assertSemver('latest')).toThrow();
    expect(() => assertSemver('1.2.x')).toThrow();
    expect(() => assertSemver('')).toThrow();
  });
});

describe('sanitizeGameBaseUrl (#47)', () => {
  it('accepts https, about:blank, and game-files:// bases', () => {
    expect(sanitizeGameBaseUrl('https://cdn.example.com/g/')).toBe('https://cdn.example.com/g/');
    expect(sanitizeGameBaseUrl('about:blank')).toBe('about:blank');
    expect(sanitizeGameBaseUrl('game-files://designs/abc-123/')).toBe(
      'game-files://designs/abc-123/',
    );
  });

  it('rejects javascript:, data:, file:, blob:, and plain http bases', () => {
    expect(() => sanitizeGameBaseUrl('javascript:alert(1)')).toThrow();
    expect(() => sanitizeGameBaseUrl('data:text/html,<script>1</script>')).toThrow();
    expect(() => sanitizeGameBaseUrl('file:///etc/passwd')).toThrow();
    expect(() => sanitizeGameBaseUrl('blob:https://x/abc')).toThrow();
    expect(() => sanitizeGameBaseUrl('http://insecure.example.com/')).toThrow();
    expect(() => sanitizeGameBaseUrl('relative/path/')).toThrow();
  });

  it('returns the unescaped url (callers escape) but does not change scheme', () => {
    // In-scheme yet contains attribute-breaking chars: still returned raw,
    // the caller is responsible for escaping.
    const tricky = 'https://x/?q="><svg';
    expect(sanitizeGameBaseUrl(tricky)).toBe(tricky);
  });
});

describe('detectNetworkReferences / networkReferenceWarning (#41)', () => {
  it('detects fetch / XHR / WebSocket', () => {
    expect(detectNetworkReferences('const r = await fetch("/x");')).toEqual(['fetch']);
    expect(detectNetworkReferences('const x = new XMLHttpRequest();')).toEqual(['XMLHttpRequest']);
    expect(detectNetworkReferences('const s = new WebSocket("wss://evil");')).toEqual([
      'WebSocket',
    ]);
  });

  it('returns empty for network-free code', () => {
    expect(detectNetworkReferences('const x = 1; render();')).toEqual([]);
  });

  it('warning names the primitives and stays advisory', () => {
    const msg = networkReferenceWarning(['fetch', 'WebSocket']);
    expect(msg).toContain('anti_exfil');
    expect(msg).toContain('fetch, WebSocket');
    expect(msg).toContain("connect-src 'self'");
  });
});
