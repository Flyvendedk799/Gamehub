/**
 * Where is the player on the screen right now?
 *
 * Runs INSIDE the game's page (Playwright serialises the function's source), so it must be fully
 * self-contained: no imports, no closure over anything outside it. That is also why the matrix
 * arithmetic is written out by hand instead of calling Three.js: the page only has what the game
 * itself loaded, and the camera's matrices are plain 16-number arrays.
 *
 * The camera comes from `window.__game.camera` (published by the engine module, see
 * engine-camera.ts in agent-core) and the position from the game's own debug snapshot
 * (`playerPos`). Returns normalised device coordinates: x from -1 (left edge) to +1 (right edge).
 * Returns null whenever it cannot know: no camera, no position, or a position behind the camera.
 *
 * Three.js matrices are column-major: element (row r, column c) lives at index c * 4 + r.
 */
export function readPlayerScreenInPage(): { x: number; y: number } | null {
  try {
    const game = (
      window as unknown as {
        __game?: {
          camera?: {
            updateMatrixWorld?: (force?: boolean) => void;
            matrixWorldInverse?: { elements?: ArrayLike<number> };
            projectionMatrix?: { elements?: ArrayLike<number> };
          };
          debug?: { snapshot?: () => { playerPos?: { x?: unknown; y?: unknown; z?: unknown } } };
        };
      }
    ).__game;
    const camera = game?.camera;
    const pos = game?.debug?.snapshot?.()?.playerPos;
    if (camera === undefined || pos === undefined || pos === null) return null;
    if (typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
    camera.updateMatrixWorld?.(true);
    const view = camera.matrixWorldInverse?.elements;
    const proj = camera.projectionMatrix?.elements;
    if (view === undefined || proj === undefined || view.length < 16 || proj.length < 16) {
      return null;
    }
    const x = pos.x;
    const y = typeof pos.y === 'number' ? pos.y : 0;
    const z = pos.z;
    // world -> view
    const vx = (view[0] ?? 0) * x + (view[4] ?? 0) * y + (view[8] ?? 0) * z + (view[12] ?? 0);
    const vy = (view[1] ?? 0) * x + (view[5] ?? 0) * y + (view[9] ?? 0) * z + (view[13] ?? 0);
    const vz = (view[2] ?? 0) * x + (view[6] ?? 0) * y + (view[10] ?? 0) * z + (view[14] ?? 0);
    // view -> clip
    const cx = (proj[0] ?? 0) * vx + (proj[4] ?? 0) * vy + (proj[8] ?? 0) * vz + (proj[12] ?? 0);
    const cy = (proj[1] ?? 0) * vx + (proj[5] ?? 0) * vy + (proj[9] ?? 0) * vz + (proj[13] ?? 0);
    const cw = (proj[3] ?? 0) * vx + (proj[7] ?? 0) * vy + (proj[11] ?? 0) * vz + (proj[15] ?? 0);
    if (!(cw > 1e-6)) return null; // behind the camera, or on its plane
    return { x: cx / cw, y: cy / cw };
  } catch {
    return null;
  }
}
