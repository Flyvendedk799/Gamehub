import { describe, expect, it } from 'vitest';
import { exposeCameraInEngine } from './engine-camera';
import { PREMIUM_STARTER_FILES } from './premium-starters';

const CORE = [
  'export function createStage(id) {',
  '  const scene = new THREE.Scene();',
  '  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);',
  '  camera.position.set(0, 7, 12); camera.lookAt(0, 0.5, -2);',
  '  return { scene, camera };',
  '}',
].join('\n');

describe('exposeCameraInEngine', () => {
  it('publishes the camera right after it is created, keeping the indentation', () => {
    const out = exposeCameraInEngine(CORE);
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.includes('new THREE.PerspectiveCamera'));
    expect(lines[at + 1]).toBe(
      '  try { window.__game.camera = camera; } catch { /* sealed contract: skip */ }',
    );
    // Nothing else moved.
    expect(out.replace(lines[at + 1] as string, '').replace('\n\n', '\n')).toBe(CORE);
  });

  it('is idempotent', () => {
    const once = exposeCameraInEngine(CORE);
    expect(exposeCameraInEngine(once)).toBe(once);
  });

  it('leaves an engine module with no 3D camera alone', () => {
    const plain = 'export function runLoop() {}\n';
    expect(exposeCameraInEngine(plain)).toBe(plain);
  });

  it('handles an orthographic camera too', () => {
    const ortho = '  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50);\n';
    expect(exposeCameraInEngine(ortho)).toContain('window.__game.camera = camera');
  });
});

describe('the starter', () => {
  it('already publishes its camera, so every new 3D game can be checked', () => {
    const core = PREMIUM_STARTER_FILES.three['src/engine/core.js'] ?? '';
    expect(core).toContain('window.__game.camera = camera');
  });

  it('is exactly what the codemod would make of an older copy of the engine module', () => {
    const patched = PREMIUM_STARTER_FILES.three['src/engine/core.js'] ?? '';
    const older = patched.replace(/\n[ \t]*try \{ window\.__game\.camera = camera;[^\n]*/, '');
    expect(older).not.toBe(patched);
    expect(exposeCameraInEngine(older)).toBe(patched);
  });
});
