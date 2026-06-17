/**
 * may9 Phase 8 follow-up #27 — Three.js trigger-zone structural lint.
 * Phaser's Tiled-JSON walker has its own test file.
 */
import { describe, expect, it } from 'vitest';
import { threeAdapter } from './three';

const THREE_INDEX = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>
</head><body><canvas id="game"></canvas><script type="module" src="src/main.js"></script></body></html>`;

function threeFiles(jsContent: string): { path: string; content: string }[] {
  return [
    { path: 'index.html', content: THREE_INDEX },
    { path: 'src/main.js', content: jsContent },
  ];
}

const THREE_BASE = `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game') });
window.addEventListener('keydown', () => {});
function tick() { requestAnimationFrame(tick); }
tick();`;

describe('threeValidate — trigger-zone contract (Phase 8 #27)', () => {
  it('FLAGS code referencing __game.world.triggers without colliders', () => {
    const result = threeAdapter.validate(
      threeFiles(`${THREE_BASE}
window.__game = window.__game || {};
window.__game.world = window.__game.world || {};
window.__game.world.triggers = [{ name: 'exit', x: 50, y: 0 }];`),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeDefined();
    }
  });

  it('PASSES when both triggers and colliders are exposed', () => {
    const result = threeAdapter.validate(
      threeFiles(`${THREE_BASE}
window.__game = window.__game || {};
window.__game.world = {
  triggers: [{ name: 'exit', x: 50, y: 0 }],
  colliders: [{ box: [0, 0, 100, 100] }],
};
window.addEventListener('keydown', () => {});`),
    );
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeUndefined();
    }
  });

  it('PASSES when there are no triggers at all (no false positives)', () => {
    const result = threeAdapter.validate(threeFiles(THREE_BASE));
    if (!result.ok) {
      const issue = result.issues.find((i) => i.message.includes('geometry.unreachable_trigger'));
      expect(issue).toBeUndefined();
    }
  });
});
