import { describe, expect, it } from 'vitest';
import { hasBrokenEngineCdnUrl, normalizeEngineCdnUrls } from './engine-cdn';

const importmap = (file: string) =>
  `<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.2/dist/${file}"}}</script>`;

describe('normalizeEngineCdnUrls', () => {
  it('rewrites the dash phaser-esm.js typo to the canonical phaser.esm.js, preserving the version', () => {
    expect(normalizeEngineCdnUrls(importmap('phaser-esm.js'))).toBe(importmap('phaser.esm.js'));
  });

  it('leaves a correct URL untouched (idempotent)', () => {
    const ok = importmap('phaser.esm.js');
    expect(normalizeEngineCdnUrls(ok)).toBe(ok);
    expect(normalizeEngineCdnUrls(normalizeEngineCdnUrls(importmap('phaser-esm.js')))).toBe(
      importmap('phaser.esm.js'),
    );
  });

  it('handles arbitrary pinned versions and is a no-op on unrelated HTML', () => {
    expect(normalizeEngineCdnUrls('cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser-esm.js')).toBe(
      'cdn.jsdelivr.net/npm/phaser@3.80.1/dist/phaser.esm.js',
    );
    expect(normalizeEngineCdnUrls('<html><body>no engine here</body></html>')).toBe(
      '<html><body>no engine here</body></html>',
    );
  });
});

describe('hasBrokenEngineCdnUrl', () => {
  it('detects the broken dash URL and clears for the correct one', () => {
    expect(hasBrokenEngineCdnUrl(importmap('phaser-esm.js'))).toBe(true);
    expect(hasBrokenEngineCdnUrl(importmap('phaser.esm.js'))).toBe(false);
    // global regex must not get stuck on lastIndex across calls
    expect(hasBrokenEngineCdnUrl(importmap('phaser-esm.js'))).toBe(true);
  });
});
