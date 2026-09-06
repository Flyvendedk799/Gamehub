import { describe, expect, it } from 'vitest';
import { detectEngineFromHtml, evaluateBootCheck } from './boot-check.js';

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
