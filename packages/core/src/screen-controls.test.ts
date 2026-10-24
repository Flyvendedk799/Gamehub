import { describe, expect, it } from 'vitest';
import { controlsFollowCameraAdvice, evaluateScreenControls } from './screen-controls';

const at = (x: number, z: number) => ({ playerPos: { x, y: 0, z } });
const step = (code: string, x: number, z: number, screenX: number) => ({
  code,
  snapshotAfter: at(x, z),
  screenAfter: { x: screenX, y: 0 },
});

describe('evaluateScreenControls', () => {
  it('passes controls that move the player the way the key points on screen', () => {
    const verdict = evaluateScreenControls({
      baselineSnapshot: at(0, 0),
      baselineScreen: { x: 0, y: 0 },
      steps: [step('KeyD', 2, 0, 0.3), step('KeyA', 0, 0, 0)],
    });
    expect(verdict).toEqual({ checked: 2, violations: [] });
  });

  it('catches the bug from run e229481c: D strafed into the depth of a side-on view', () => {
    // The camera looks along -X, so the screen's horizontal axis is Z. D moved the player along X
    // (toward the camera), which barely moves them sideways on screen.
    const verdict = evaluateScreenControls({
      baselineSnapshot: at(0, 3.8),
      baselineScreen: { x: 0.1, y: 0 },
      steps: [step('KeyD', 1.5, 3.8, 0.11), step('KeyA', 0, 3.8, 0.1)],
    });
    expect(verdict.checked).toBe(2);
    expect(verdict.violations).toHaveLength(2);
    expect(verdict.violations[0]).toContain('KeyD (right)');
    expect(verdict.violations[0]).toContain('almost straight toward or away from the camera');
  });

  it('catches controls that are mirrored', () => {
    const verdict = evaluateScreenControls({
      baselineSnapshot: at(0, 0),
      baselineScreen: { x: 0, y: 0 },
      steps: [step('ArrowRight', -2, 0, -0.4)],
    });
    expect(verdict.violations).toEqual([
      'Holding ArrowRight (right) moved the player to the LEFT on screen (20% of the screen width), not right.',
    ]);
  });

  it('abstains when the player did not move (a wall, or a key that is a dodge)', () => {
    const verdict = evaluateScreenControls({
      baselineSnapshot: at(5, 5),
      baselineScreen: { x: 0.5, y: 0 },
      steps: [step('KeyD', 5.05, 5, 0.5)],
    });
    expect(verdict).toEqual({ checked: 0, violations: [] });
  });

  it('abstains with no camera, no player position, or an unknown key', () => {
    expect(
      evaluateScreenControls({
        baselineSnapshot: at(0, 0),
        baselineScreen: null,
        steps: [{ code: 'KeyD', snapshotAfter: at(3, 0), screenAfter: null }],
      }).checked,
    ).toBe(0);
    expect(
      evaluateScreenControls({
        baselineSnapshot: { score: 1 },
        baselineScreen: { x: 0, y: 0 },
        steps: [step('KeyD', 3, 0, 0.5)],
      }).checked,
    ).toBe(0);
    expect(
      evaluateScreenControls({
        baselineSnapshot: at(0, 0),
        baselineScreen: { x: 0, y: 0 },
        steps: [step('Space', 3, 0, -0.5)],
      }).checked,
    ).toBe(0);
  });

  it('judges each key from where the previous one left the player', () => {
    const verdict = evaluateScreenControls({
      baselineSnapshot: at(0, 0),
      baselineScreen: { x: 0, y: 0 },
      // Right works (0 -> 0.5); left then moves from 0.5 to 0.48: not left enough.
      steps: [step('KeyD', 2, 0, 0.5), step('KeyA', 1.5, 0, 0.48)],
    });
    expect(verdict.checked).toBe(2);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toContain('KeyA (left)');
  });
});

describe('controlsFollowCameraAdvice', () => {
  it('names the failures and tells the agent how to derive input from the camera', () => {
    const advice = controlsFollowCameraAdvice([
      'Holding KeyD (right) moved the player to the LEFT',
    ]);
    expect(advice).toContain('Holding KeyD (right)');
    expect(advice).toContain('camera.getWorldDirection');
    expect(advice).toContain('Do not change the camera back');
  });
});
