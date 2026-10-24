import { afterEach, describe, expect, it } from 'vitest';
import { readPlayerScreenInPage } from './screen-projection';

type Fake = { __game?: unknown };
const globals = globalThis as unknown as { window?: Fake | undefined };

afterEach(() => {
  globals.window = undefined;
});

/** A camera at (0, 0, 5) looking down -Z: the view matrix is a translation by (0, 0, -5). */
const VIEW = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1];
/** Perspective projection, 90 degree fov, aspect 1, near 0.1, far 100 (column-major). */
const PROJ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002002, -1, 0, 0, -0.2002002, 0];

function game(playerPos: unknown, camera: unknown = camera3d()) {
  globals.window = {
    __game: { camera, debug: { snapshot: () => ({ playerPos }) } },
  };
}

function camera3d(view: number[] = VIEW) {
  return {
    updateMatrixWorld: () => {},
    matrixWorldInverse: { elements: view },
    projectionMatrix: { elements: PROJ },
  };
}

describe('readPlayerScreenInPage', () => {
  it('projects the player onto the screen: right of the camera axis is positive x', () => {
    game({ x: 1, y: 0, z: 0 });
    const right = readPlayerScreenInPage();
    expect(right?.x).toBeCloseTo(0.2, 3);
    game({ x: -1, y: 0, z: 0 });
    expect(readPlayerScreenInPage()?.x).toBeCloseTo(-0.2, 3);
    game({ x: 0, y: 0, z: 0 });
    expect(readPlayerScreenInPage()?.x).toBeCloseTo(0, 5);
  });

  it('puts a player nearer the camera further from the centre for the same offset', () => {
    game({ x: 1, y: 0, z: 0 });
    const far = readPlayerScreenInPage()?.x ?? 0;
    game({ x: 1, y: 0, z: 3 });
    const near = readPlayerScreenInPage()?.x ?? 0;
    expect(near).toBeGreaterThan(far);
  });

  it('answers null whenever it cannot know', () => {
    globals.window = { __game: { debug: { snapshot: () => ({ playerPos: { x: 1, z: 0 } }) } } };
    expect(readPlayerScreenInPage()).toBeNull(); // no camera published
    game(undefined);
    expect(readPlayerScreenInPage()).toBeNull(); // no player position
    game({ x: 1, y: 2 });
    expect(readPlayerScreenInPage()).toBeNull(); // 2D position, no z
    game({ x: 0, y: 0, z: 9 });
    expect(readPlayerScreenInPage()).toBeNull(); // behind the camera
    globals.window = undefined;
    expect(readPlayerScreenInPage()).toBeNull(); // not even a window
  });

  it('survives a camera whose matrices are missing', () => {
    game({ x: 1, y: 0, z: 0 }, { updateMatrixWorld: () => {} });
    expect(readPlayerScreenInPage()).toBeNull();
  });
});
