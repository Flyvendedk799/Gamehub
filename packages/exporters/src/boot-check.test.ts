import { describe, expect, it } from 'vitest';
import {
  bundleHasGameContract,
  detectEngineFromHtml,
  evaluateBootCheck,
  searchableBundleSource,
} from './boot-check.js';

describe('S14 boot-check', () => {
  it('rejects Phaser bootstrap for a Three project', () => {
    const html = `<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3.88.0/dist/phaser.esm.js"}}</script>`;
    const detected = detectEngineFromHtml(html);
    const result = evaluateBootCheck({
      hasGameContract: true,
      fatalErrors: [],
      declaredEngine: 'three',
      detectedEngine: detected,
    });
    expect(detected).toBe('phaser');
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/engine mismatch/);
  });

  it('passes a matching Three bundle that booted', () => {
    const html = `import * as THREE from 'three'; window.__game = {}`;
    const detected = detectEngineFromHtml(html);
    const result = evaluateBootCheck({
      hasGameContract: true,
      fatalErrors: [],
      declaredEngine: 'three',
      detectedEngine: detected,
    });
    expect(detected).toBe('three');
    expect(result.ok).toBe(true);
  });

  it('rejects silent bundles when requireAudio is set', () => {
    const result = evaluateBootCheck({
      hasGameContract: true,
      fatalErrors: [],
      declaredEngine: 'phaser',
      detectedEngine: 'phaser',
      requireAudio: true,
      audioPlays: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/audioPlays/);
  });
});

describe('scanning an EXPORTED bundle (base64-inlined modules)', () => {
  /** What buildGameHtml actually produces: the game's module is not text in the
   *  document, it is a base64 data: URL. */
  function exportedBundle(moduleSource: string): string {
    const b64 = Buffer.from(moduleSource, 'utf8').toString('base64');
    return (
      '<!doctype html><html><head><title>g</title></head><body><div id="game"></div>' +
      `<script type="module" src="data:text/javascript;base64,${b64}"></script>` +
      '</body></html>'
    );
  }

  const THREE_GAME = [
    "import * as THREE from 'three';",
    'window.__game = window.__game || {};',
    'window.__game.debug = { snapshot: () => null };',
  ].join('\n');

  it('sees window.__game through a base64-inlined module', () => {
    const html = exportedBundle(THREE_GAME);
    // The regression: a raw scan of the assembled bundle finds nothing, because
    // the source only exists as base64. Publish returned 422 on every
    // multi-file game for exactly this reason.
    expect(/window\.__game/.test(html)).toBe(false);
    expect(bundleHasGameContract(html)).toBe(true);
  });

  it('detects the engine through a base64-inlined module', () => {
    expect(detectEngineFromHtml(exportedBundle(THREE_GAME))).toBe('three');
    expect(detectEngineFromHtml(exportedBundle("import Phaser from 'phaser';"))).toBe('phaser');
  });

  it('lets a real exported three game PASS the static publish gate', () => {
    const html = exportedBundle(THREE_GAME);
    const result = evaluateBootCheck({
      hasGameContract: bundleHasGameContract(html),
      fatalErrors: [],
      declaredEngine: 'three',
      detectedEngine: detectEngineFromHtml(html),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('still FAILS a bundle that genuinely has no game contract', () => {
    // The gate must keep its teeth — decoding must not turn it into a rubber stamp.
    const html = exportedBundle('console.log("just a script, no game");');
    expect(bundleHasGameContract(html)).toBe(false);
  });

  it('does not decode binary payloads (images/audio are megabytes of noise)', () => {
    const imgB64 = Buffer.from('window.__game = 1').toString('base64');
    const html = `<img src="data:image/png;base64,${imgB64}">`;
    // A PNG that happens to contain those bytes must not be mistaken for source.
    expect(bundleHasGameContract(html)).toBe(false);
  });

  it('is unchanged for a bundle with no data: URLs at all', () => {
    const plain = '<html><script>window.__game = {};</script></html>';
    expect(searchableBundleSource(plain)).toBe(plain);
    expect(bundleHasGameContract(plain)).toBe(true);
  });
});
